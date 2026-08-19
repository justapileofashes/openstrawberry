/**
 * Owns downloads in the trusted process.
 *
 * The shape mirrors `BrowserManager`: an options object carrying a `publish`
 * callback, every mutation ending in `emit()`, and an idempotent `destroy()`
 * that is safe to call twice and safe once the window has begun closing.
 *
 * One boundary carries the whole feature. **The save path never leaves this
 * class.** It is computed here, held in a private map keyed by an id this class
 * minted, and used here. `DownloadItem` has no field it would fit in, and
 * `reveal` takes an id rather than a location, so the renderer can ask for a
 * file it already knows about to be shown and cannot ask for anything else to
 * be. That is what makes reveal safe to expose at all.
 *
 * The destination is chosen rather than prompted. Electron's default is a save
 * dialog per download; instead the file goes to the OS downloads folder under a
 * name `safeFileName` has already reduced, with a numeric suffix when that name
 * is taken. Deciding the name here is what keeps a server-supplied string from
 * ever reaching the filesystem unexamined.
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { DownloadItem as ElectronDownloadItem, Event, Session, WebContents } from "electron";
import {
  boundDownloads,
  emptyDownloadSnapshot,
  isTerminalDownloadState,
  parsePersistedDownloads,
  safeFileName,
  toPersistedDownloads,
  type DownloadItem,
  type DownloadSnapshot,
  type DownloadState
} from "../shared/downloads.js";
import { writeFileAtomically } from "./atomic-write.js";

/**
 * Revealing a file in the OS file manager.
 *
 * Injected so the manager is testable without Electron, and so the one call
 * that hands a path to the operating system is a named seam rather than an
 * import buried in a method.
 */
export type RevealPort = (path: string) => void;

export interface DownloadManagerOptions {
  /** The app-owned partition guests render into; downloads originate there. */
  readonly session: Pick<Session, "on">;
  /** Where files land. Never sent to the renderer. */
  readonly downloadDir: string;
  /** The folder's display name, which is what the renderer is told instead. */
  readonly directoryLabel: string;
  readonly statePath: string;
  readonly publish: (snapshot: DownloadSnapshot) => void;
  readonly reveal: RevealPort;
  /** Injected so timestamps are checkable. */
  readonly now?: () => number;
}

/** What the manager tracks per download, including the half the renderer never sees. */
interface DownloadRuntime {
  state: DownloadItem;
  /** Trusted-process only. The reason `reveal` can take an id. */
  savePath: string;
  /** Null once the download has finished and Electron released it. */
  handle: ElectronDownloadItem | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * A name that is not already taken in the destination directory.
 *
 * Chromium's own convention: `report.pdf`, then `report (1).pdf`. Overwriting
 * silently would destroy a file the user already has, and the collision is
 * common enough - downloading the same thing twice - that failing would be
 * worse than renaming.
 *
 * The scan is bounded. A directory holding a thousand collisions of one name is
 * not a case worth looping over, and the timestamped fallback always terminates.
 */
export function uniqueFileName(
  directory: string,
  fileName: string,
  exists: (path: string) => boolean = existsSync
): string {
  if (!exists(join(directory, fileName))) return fileName;

  const extension = extname(fileName);
  const stem = extension.length > 0 ? fileName.slice(0, -extension.length) : fileName;

  for (let counter = 1; counter <= 999; counter += 1) {
    const candidate = `${stem} (${counter})${extension}`;
    if (!exists(join(directory, candidate))) return candidate;
  }

  return `${stem}-${Date.now()}${extension}`;
}

export class DownloadManager {
  private readonly downloadDir: string;
  private readonly directoryLabel: string;
  private readonly statePath: string;
  private readonly publish: (snapshot: DownloadSnapshot) => void;
  private readonly reveal: RevealPort;
  private readonly now: () => number;

  private readonly downloads = new Map<string, DownloadRuntime>();
  /** Preserves arrival order, which is the order the panel lists. */
  private order: string[] = [];

  private nextSequence = 1;
  private destroyed = false;

  public constructor(options: DownloadManagerOptions) {
    this.downloadDir = options.downloadDir;
    this.directoryLabel = options.directoryLabel;
    this.statePath = options.statePath;
    this.publish = options.publish;
    this.reveal = options.reveal;
    this.now = options.now ?? ((): number => Date.now());

    options.session.on("will-download", (_event: Event, item: ElectronDownloadItem, webContents: WebContents) => {
      this.adopt(item, webContents);
    });
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Restores finished downloads so the panel has history.
   *
   * Nothing restored is live: `parsePersistedDownloads` downgrades any stored
   * in-flight state, because the transfer died with the previous process.
   */
  public restore(): void {
    const persisted = parsePersistedDownloads(this.readStateFile());

    for (const item of persisted.items) {
      // A restored item has no save path, so it cannot be revealed. The file may
      // well still be on disk, but this process was not the one that put it
      // there and has not been told where.
      this.downloads.set(item.id, { state: item, savePath: "", handle: null });
      this.order.push(item.id);

      const suffix = Number.parseInt(item.id.replace(/^download-/u, ""), 10);
      if (Number.isInteger(suffix) && suffix >= this.nextSequence) {
        this.nextSequence = suffix + 1;
      }
    }

    this.emit();
  }

  /** Safe to call twice, and safe once the window has begun closing. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      this.persistState();
    } catch {
      // History that cannot be written must never block a clean exit.
    }

    // Handles belong to a session that is going away. Dropping the references
    // here means no later callback finds a half-torn-down manager.
    for (const runtime of this.downloads.values()) runtime.handle = null;
  }

  /* --------------------------------------------------------------------- */
  /* Adoption                                                              */
  /* --------------------------------------------------------------------- */

  private adopt(item: ElectronDownloadItem, webContents: WebContents | null): void {
    if (this.destroyed) {
      item.cancel();
      return;
    }

    const id = `download-${this.nextSequence++}`;

    // The server's suggestion is reduced before it reaches the filesystem, and
    // again made unique, so neither a hostile name nor an ordinary collision can
    // overwrite anything.
    const suggested = safeFileName(item.getFilename());
    const fileName = uniqueFileName(this.downloadDir, suggested);
    const savePath = join(this.downloadDir, fileName);

    // Setting the path suppresses Electron's save dialog. The name was decided
    // here, from a string this process sanitised.
    item.setSavePath(savePath);

    const startedAt = this.now();
    const runtime: DownloadRuntime = {
      savePath,
      handle: item,
      state: {
        id,
        // basename, because a platform could hand back a path here and the
        // renderer must be given a name.
        fileName: basename(savePath),
        host: hostOf(item.getURL()),
        state: "progressing",
        receivedBytes: 0,
        totalBytes: Math.max(0, item.getTotalBytes()),
        canResume: false,
        directoryLabel: this.directoryLabel,
        startedAt,
        endedAt: null
      }
    };

    this.downloads.set(id, runtime);
    this.order.push(id);
    this.trim();

    item.on("updated", (_updateEvent: Event, state: string) => {
      this.refresh(id, state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing");
    });

    item.on("done", (_doneEvent: Event, state: string) => {
      const finished: DownloadState =
        state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
      this.refresh(id, finished);

      // Electron releases the item after `done`; holding the reference would
      // leave a handle whose methods throw.
      const current = this.downloads.get(id);
      if (current !== undefined) current.handle = null;

      this.persistQuietly();
    });

    void webContents;
    this.emit();
  }

  /* --------------------------------------------------------------------- */
  /* Commands                                                              */
  /* --------------------------------------------------------------------- */

  public pause(downloadId: string): DownloadSnapshot {
    const runtime = this.downloads.get(downloadId);
    if (runtime?.handle == null) return this.snapshot();

    try {
      runtime.handle.pause();
    } catch {
      // The item can finish between the renderer deciding and this running.
    }
    return this.refresh(downloadId, "paused");
  }

  public resume(downloadId: string): DownloadSnapshot {
    const runtime = this.downloads.get(downloadId);
    if (runtime?.handle == null) return this.snapshot();

    try {
      // `canResume` is Chromium's answer, not ours. A download the server will
      // not let us continue must not be offered as resumable.
      if (runtime.handle.canResume()) runtime.handle.resume();
    } catch {
      return this.snapshot();
    }
    return this.refresh(downloadId, "progressing");
  }

  public cancel(downloadId: string): DownloadSnapshot {
    const runtime = this.downloads.get(downloadId);
    if (runtime?.handle == null) return this.snapshot();

    try {
      runtime.handle.cancel();
    } catch {
      // Same race as pause; the `done` handler reports the real outcome.
    }
    return this.snapshot();
  }

  /**
   * Shows a completed file in the OS file manager.
   *
   * The id is resolved to a path this process chose. A download that did not
   * complete, or one restored from a previous run whose location this process
   * never knew, has no path and is silently not revealed - there is nothing
   * truthful to show.
   */
  public showInFolder(downloadId: string): DownloadSnapshot {
    const runtime = this.downloads.get(downloadId);
    if (runtime === undefined) return this.snapshot();
    if (runtime.state.state !== "completed" || runtime.savePath.length === 0) {
      return this.snapshot();
    }

    // A file the user has since moved or deleted is not an error worth raising;
    // the panel keeps listing it and nothing opens.
    if (!existsSync(runtime.savePath)) return this.snapshot();

    try {
      this.reveal(runtime.savePath);
    } catch {
      // Revealing is a convenience. A file manager that will not open is not a
      // failure the download should report.
    }
    return this.snapshot();
  }

  /**
   * Forgets finished downloads.
   *
   * The files are left alone. Clearing a list is a request about the list, and
   * deleting a user's files because they tidied a panel would be a surprise of
   * the worst kind.
   */
  public clearFinished(): DownloadSnapshot {
    for (const [id, runtime] of [...this.downloads]) {
      if (!isTerminalDownloadState(runtime.state.state)) continue;
      this.downloads.delete(id);
    }
    this.order = this.order.filter((id) => this.downloads.has(id));

    this.persistQuietly();
    return this.emit();
  }

  /* --------------------------------------------------------------------- */
  /* Snapshot                                                              */
  /* --------------------------------------------------------------------- */

  public snapshot(): DownloadSnapshot {
    if (this.downloads.size === 0) return emptyDownloadSnapshot();

    const items: DownloadItem[] = [];
    for (const id of this.order) {
      const runtime = this.downloads.get(id);
      if (runtime !== undefined) items.push(runtime.state);
    }

    return {
      items,
      hasActive: items.some((item) => !isTerminalDownloadState(item.state))
    };
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  private emit(): DownloadSnapshot {
    const next = this.snapshot();
    if (!this.destroyed) this.publish(next);
    return next;
  }

  /** Re-reads live counters from the handle and applies a new state. */
  private refresh(downloadId: string, state: DownloadState): DownloadSnapshot {
    const runtime = this.downloads.get(downloadId);
    if (runtime === undefined) return this.snapshot();

    let receivedBytes = runtime.state.receivedBytes;
    let totalBytes = runtime.state.totalBytes;
    let canResume = false;

    const handle = runtime.handle;
    if (handle !== null) {
      try {
        receivedBytes = Math.max(0, handle.getReceivedBytes());
        totalBytes = Math.max(0, handle.getTotalBytes());
        canResume = handle.canResume();
      } catch {
        // A released handle keeps whatever was last read.
      }
    }

    const terminal = isTerminalDownloadState(state);

    runtime.state = {
      ...runtime.state,
      state,
      receivedBytes,
      totalBytes,
      // Only a live download can be resumed, so a finished one never advertises
      // an action that would do nothing.
      canResume: terminal ? false : canResume,
      endedAt: terminal ? (runtime.state.endedAt ?? this.now()) : null
    };

    return this.emit();
  }

  /** Keeps the retained list bounded as new downloads arrive. */
  private trim(): void {
    const bounded = boundDownloads(
      this.order
        .map((id) => this.downloads.get(id))
        .filter((runtime): runtime is DownloadRuntime => runtime !== undefined)
        .map((runtime) => runtime.state)
    );

    const keep = new Set(bounded.map((item) => item.id));
    for (const id of [...this.downloads.keys()]) {
      // An in-flight download is never evicted by the cap; dropping it would
      // orphan a transfer that is still writing to disk.
      const runtime = this.downloads.get(id);
      if (runtime !== undefined && !isTerminalDownloadState(runtime.state.state)) continue;
      if (!keep.has(id)) this.downloads.delete(id);
    }
    this.order = this.order.filter((id) => this.downloads.has(id));
  }

  private persistQuietly(): void {
    try {
      this.persistState();
    } catch {
      // History is a convenience; a failed write costs nothing at rest.
    }
  }

  private readStateFile(): unknown {
    try {
      // Strip a byte-order mark, which an editor or sync tool could introduce
      // and which would otherwise discard the whole file.
      const text = readFileSync(this.statePath, "utf8").replace(/^\uFEFF/u, "");
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private persistState(): void {
    writeFileAtomically(this.statePath, JSON.stringify(toPersistedDownloads(this.snapshot())));
  }
}
