/**
 * The downloads contract.
 *
 * A download is the one place where remote content becomes a file on the user's
 * disk, so three rules shape everything in this module:
 *
 *   1. **The renderer never learns a path.** A `DownloadItem` carries a file
 *      *name* and a directory *label*, never a location. There is no field on
 *      any type here that an absolute path fits in, which is what keeps the
 *      trusted process the only holder of one.
 *   2. **The renderer never chooses a path.** Every verb below names a download
 *      by an id the trusted process minted. Revealing a file is a request to
 *      reveal *that item*, not a request to open a location the renderer named.
 *   3. **The file name is the remote server's suggestion, and is treated as
 *      hostile.** `safeFileName` is the single gate, applied before a name is
 *      stored, displayed, or written.
 *
 * The state machine mirrors Electron's own so the manager translates rather than
 * interprets: a download that Chromium calls interrupted is reported interrupted
 * here, and whether it can be resumed is a fact read from the item rather than
 * inferred.
 *
 * This file is deliberately pure ASCII. Its character classes are the security
 * gate, and an escape is reviewable in a way a pasted invisible control
 * character is not.
 */

import {
  MAX_TEXT_LENGTH,
  requireIdentifier,
  requirePlainObject
} from "./ipc-validation.js";

/** How many finished downloads the panel keeps. Bounds both memory and the file. */
export const MAX_DOWNLOADS_RETAINED = 100;

/**
 * Bounds a stored file name.
 *
 * Well under what any filesystem accepts, because this is a display string that
 * also has to be readable in a narrow panel. A longer name is truncated rather
 * than rejected: the download itself is fine, only its label is unwieldy.
 */
export const MAX_FILE_NAME_LENGTH = 128;

/** Bounds the host label shown beside an item. */
export const MAX_HOST_LENGTH = 128;

/** Later than any real download, and early enough to bound the field. */
export const MAX_TIMESTAMP = 4_102_444_800_000;

/**
 * The states a download can be in.
 *
 * `interrupted` is deliberately distinct from `cancelled`: one is a failure the
 * user may be able to resume, the other is a decision they made. Collapsing them
 * would offer a retry for something nobody wants retried.
 */
export const DOWNLOAD_STATES = [
  "progressing",
  "paused",
  "completed",
  "cancelled",
  "interrupted"
] as const;

export type DownloadState = (typeof DOWNLOAD_STATES)[number];

export function isTerminalDownloadState(state: DownloadState): boolean {
  return state === "completed" || state === "cancelled" || state === "interrupted";
}

/**
 * One download, as the renderer sees it.
 *
 * Note the absence of a path. `directoryLabel` is the *name* of the folder the
 * file landed in, so the panel can say where something went without the renderer
 * being told where that is.
 */
export interface DownloadItem {
  readonly id: string;
  /** Sanitised. See `safeFileName`. */
  readonly fileName: string;
  /** The host the file came from, for recognition. Never the full URL. */
  readonly host: string;
  readonly state: DownloadState;
  /** Bytes received so far. */
  readonly receivedBytes: number;
  /** Total bytes, or 0 when the server declared no length. */
  readonly totalBytes: number;
  /** Whether a paused or interrupted item can be resumed. Read, not inferred. */
  readonly canResume: boolean;
  /** The folder's display name, never its path. */
  readonly directoryLabel: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface DownloadSnapshot {
  readonly items: readonly DownloadItem[];
  /** True while any item is progressing, so the chrome can mark the trigger. */
  readonly hasActive: boolean;
}

export function emptyDownloadSnapshot(): DownloadSnapshot {
  return { items: [], hasActive: false };
}

/* -------------------------------------------------------------------------- */
/* File names                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Windows device names, which are not usable as file names on any Windows
 * filesystem regardless of extension. A download called `CON.txt` would fail to
 * write, so it is renamed rather than attempted.
 */
const RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"
]);

const FALLBACK_NAME = "download";

/** C0 controls, DEL, C1 controls. */
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "gu");

/**
 * Bidirectional overrides and isolates.
 *
 * These are how a name ending "txt<U+202E>gpj.exe" renders as "txtexe.jpg": the
 * override reverses the display order, so the extension the user reads is not
 * the extension the file has. Removed rather than escaped, because none of them
 * has any business in a file name.
 */
const BIDI_OVERRIDES = new RegExp("[\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]", "gu");

/** Characters no Windows filesystem accepts. */
const ILLEGAL_CHARACTERS = /[<>:"|?*]/gu;

/**
 * Reduces a server-suggested file name to something safe to write and display.
 *
 * The name arrives in a `Content-Disposition` header controlled by whoever
 * served the file, so it is treated as hostile input rather than as a label:
 *
 *   - **Separators go first.** `/` and `\` are what turn a file name into a
 *     path. Replacing them means the result cannot address a directory at all,
 *     which is a stronger guarantee than checking for `..` and hoping the list
 *     of tricks is complete.
 *   - **Control characters and bidirectional overrides are removed**, because a
 *     name containing them either fails to write or renders as something other
 *     than what was stored.
 *   - **A leading dot is dropped**, so a download cannot quietly become a hidden
 *     file the user does not notice arriving.
 *   - **A trailing dot or space is dropped**, which Windows silently strips
 *     anyway; leaving them would mean the file on disk and the name in the panel
 *     disagree.
 *
 * Truncation preserves the extension, because the extension is what decides how
 * the file opens and losing it is worse than losing the middle of a long name.
 */
export function safeFileName(suggested: string): string {
  // Separators first: everything after this is a single path segment.
  const flattened = suggested.replace(/[/\\]/gu, " ");

  const cleaned = flattened
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_OVERRIDES, "")
    .replace(ILLEGAL_CHARACTERS, "")
    .replace(/\s+/gu, " ")
    .trim()
    /*
     * Drop what the traversal segments left behind.
     *
     * Flattening the separators already made escape impossible - there is no
     * separator left to address a directory with - so this is not the security
     * step. It is that "../../../evil.exe" would otherwise be saved as
     * ".. .. evil.exe", and a name carrying the debris of an attempted attack
     * is worse to hand a user than the plain name underneath it.
     */
    .split(" ")
    .filter((token) => !/^\.+$/u.test(token))
    .join(" ")
    .trim()
    // A name that is only dots addresses a directory.
    .replace(/^\.+/u, "")
    // Windows strips these on write; dropping them keeps disk and panel in step.
    .replace(/[. ]+$/u, "")
    .trim();

  if (cleaned.length === 0) return FALLBACK_NAME;

  const dot = cleaned.lastIndexOf(".");
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const extension = dot > 0 ? cleaned.slice(dot) : "";

  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    return `${FALLBACK_NAME}-${stem.toLowerCase()}${extension}`;
  }

  if (cleaned.length <= MAX_FILE_NAME_LENGTH) return cleaned;

  // Keep the extension; trim the stem. An extension long enough to crowd out the
  // name is not one worth preserving.
  if (extension.length > 0 && extension.length < 24) {
    const room = MAX_FILE_NAME_LENGTH - extension.length;
    return `${stem.slice(0, room).trimEnd()}${extension}`;
  }

  return cleaned.slice(0, MAX_FILE_NAME_LENGTH).trimEnd();
}

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/** Trims the retained list, keeping the most recent. */
export function boundDownloads(items: readonly DownloadItem[]): readonly DownloadItem[] {
  if (items.length <= MAX_DOWNLOADS_RETAINED) return items;
  return items.slice(items.length - MAX_DOWNLOADS_RETAINED);
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface DownloadIdPayload {
  readonly downloadId: string;
}

export function parseDownloadIdPayload(raw: unknown): DownloadIdPayload {
  const root = requirePlainObject(raw, "Download request");
  return { downloadId: requireIdentifier(root["downloadId"], "Download ID") };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export const DOWNLOAD_STATE_VERSION = 1;

export interface PersistedDownloadState {
  readonly version: number;
  readonly items: readonly DownloadItem[];
}

function parseState(value: unknown): DownloadState {
  if (typeof value !== "string") return "interrupted";
  return (DOWNLOAD_STATES as readonly string[]).includes(value)
    ? (value as DownloadState)
    : "interrupted";
}

function parseCount(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return Math.min(Math.floor(value), max);
}

function parseText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Reads one persisted item.
 *
 * Returns null rather than throwing on anything unreadable, so one damaged entry
 * costs that entry rather than the whole history.
 */
function parseItem(raw: unknown): DownloadItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;

  let id: string;
  try {
    id = requireIdentifier(item["id"], "Download id");
  } catch {
    return null;
  }

  const fileName = safeFileName(parseText(item["fileName"], MAX_TEXT_LENGTH));
  if (fileName.length === 0) return null;

  /*
   * A restored download is never live. The process that was writing it is gone,
   * so anything that claimed to be in flight is reported as interrupted, and
   * cannot be resumed because Electron's resume needs the item that is no longer
   * there. Reporting it as still progressing would leave a bar that never moves.
   */
  const stored = parseState(item["state"]);
  const state: DownloadState = isTerminalDownloadState(stored) ? stored : "interrupted";

  return {
    id,
    fileName,
    host: parseText(item["host"], MAX_HOST_LENGTH),
    state,
    receivedBytes: parseCount(item["receivedBytes"], Number.MAX_SAFE_INTEGER),
    totalBytes: parseCount(item["totalBytes"], Number.MAX_SAFE_INTEGER),
    canResume: false,
    directoryLabel: parseText(item["directoryLabel"], MAX_TEXT_LENGTH),
    startedAt: parseCount(item["startedAt"], MAX_TIMESTAMP),
    endedAt:
      typeof item["endedAt"] === "number" ? parseCount(item["endedAt"], MAX_TIMESTAMP) : null
  };
}

export function parsePersistedDownloads(raw: unknown): PersistedDownloadState {
  const empty: PersistedDownloadState = { version: DOWNLOAD_STATE_VERSION, items: [] };

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const root = raw as Record<string, unknown>;
  if (root["version"] !== DOWNLOAD_STATE_VERSION) return empty;

  const rawItems = root["items"];
  if (!Array.isArray(rawItems)) return empty;

  const items: DownloadItem[] = [];
  const seen = new Set<string>();

  for (const entry of rawItems.slice(0, MAX_DOWNLOADS_RETAINED)) {
    const item = parseItem(entry);
    if (item === null || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  return { version: DOWNLOAD_STATE_VERSION, items };
}

export function toPersistedDownloads(snapshot: DownloadSnapshot): PersistedDownloadState {
  return {
    version: DOWNLOAD_STATE_VERSION,
    // Only finished downloads are worth restoring. An in-flight one dies with
    // the process, and writing it would restore a progress bar for a transfer
    // nothing is performing.
    items: boundDownloads(snapshot.items.filter((item) => isTerminalDownloadState(item.state)))
  };
}
