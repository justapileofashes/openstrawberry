/**
 * The migration runtime.
 *
 * Everything the wizard can do passes through here, and the rules it enforces
 * are the ones the feature exists to keep:
 *
 *   - **Nothing is read before it is chosen.** Detection reports which browsers
 *     exist; a bookmark file is opened only once the user has named a source and
 *     a profile, and an export or CSV only once they have picked it in a native
 *     dialog this process opened.
 *   - **The renderer never supplies a path.** A source is named by an id the
 *     registry minted. A picked file is named by an opaque handle this class
 *     minted. Neither can be pointed anywhere else, and an id or handle that was
 *     not issued resolves to nothing.
 *   - **Review is binding.** A preview parses the file once and keeps the parsed
 *     records against the handle. The commit imports exactly those records, so
 *     what the user approved is what lands even if the file changes underneath.
 *   - **Failures are states, not exceptions.** A locked profile, a corrupt file,
 *     an unreadable directory, and a system with no encryption are all ordinary
 *     things a user can hit. Each becomes a warning code the wizard renders,
 *     never a raw error carrying a path into a log or across IPC.
 *
 * Nothing here is reachable from an agent. The bridge exposes migration to the
 * chrome only, the parsed records never leave this process, and the vault has no
 * read path at all.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  MAX_BOOKMARK_FILE_BYTES,
  MAX_CSV_FILE_BYTES,
  MAX_SEARCH_NAME_LENGTH,
  WarningLedger,
  toBookmarkPreview,
  type BookmarkPreviewResponse,
  type BookmarkSourceKind,
  type HtmlSourceKind,
  type ImportedBookmark,
  type MigrationCommitPayload,
  type MigrationOverview,
  type MigrationPreviewPayload,
  type MigrationResult,
  type MigrationStateRecord,
  type MigrationWarning,
  type PickedBookmarkFile,
  type PickedPasswordFile,
  MIGRATION_HANDLE_TTL_MS
} from "../shared/migration.js";
import type { EncryptionState } from "../shared/agents.js";
import {
  bookmarkLabel,
  emptyBookmarkPage,
  matchesBookmarkQuery,
  MAX_BOOKMARK_RESULTS,
  type BookmarkEntry,
  type BookmarkPage
} from "../shared/bookmarks.js";
import {
  parseChromiumBookmarks,
  parseChromiumSearchName,
  parseHtmlBookmarks
} from "./bookmark-parsers.js";
import { parsePasswordCsv, type StagedPasswordRecord } from "./password-csv.js";
import {
  detectBrowsers,
  profileKey,
  sourceCandidates,
  type DetectionPort,
  type DetectionResult,
  type RegistryEnvironment
} from "./migration-sources.js";
import {
  BookmarkStore,
  MigrationStateStore,
  StagedPasswordVault,
  StagedPasswordStorageUnavailableError
} from "./migration-store.js";
import type { CipherPort } from "./secret-store.js";

/** Extensions the pickers accept, checked again after the dialog returns. */
const BOOKMARK_EXTENSIONS: readonly string[] = [".html", ".htm"];
const CSV_EXTENSIONS: readonly string[] = [".csv"];

/**
 * A native file dialog, as this module needs it.
 *
 * Injected so the whole runtime is testable without Electron, and so the only
 * way a path enters this class is through a dialog the user answered.
 */
export interface MigrationDialogPort {
  readonly openFile: (request: {
    readonly title: string;
    readonly buttonLabel: string;
    readonly filterName: string;
    readonly extensions: readonly string[];
  }) => Promise<string | null>;
}

export interface MigrationManagerOptions {
  readonly userDataDir: string;
  readonly cipher: CipherPort;
  readonly environment: RegistryEnvironment;
  readonly dialog: MigrationDialogPort;
  /** Injected so handle expiry is testable. */
  readonly now?: () => number;
}

/* ------------------------------------------------------------------------- */
/* Staged handles                                                             */
/* ------------------------------------------------------------------------- */

interface BookmarkHandleEntry {
  readonly kind: "bookmark";
  readonly sourceKind: BookmarkSourceKind;
  readonly sourceId: string | null;
  readonly profileId: string | null;
  readonly bookmarks: readonly ImportedBookmark[];
  readonly folderCount: number;
  readonly searchName: string | null;
  readonly expiresAt: number;
}

interface PasswordHandleEntry {
  readonly kind: "password";
  /** Plaintext credentials. Never leaves this process except as ciphertext. */
  readonly records: readonly StagedPasswordRecord[];
  readonly expiresAt: number;
}

type HandleEntry = BookmarkHandleEntry | PasswordHandleEntry;

/* ------------------------------------------------------------------------- */
/* Bounded reads                                                              */
/* ------------------------------------------------------------------------- */

type ReadOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "too-large" | "unreadable" };

/**
 * Reads a file only if it is small enough to be worth reading.
 *
 * The size is checked before the bytes are pulled in, so an enormous or
 * pathological file costs a `stat` rather than a heap the size of the file. The
 * failure reasons are deliberately coarse: a caller turns them into a warning
 * code, and no filesystem error — which would carry the path — escapes.
 */
function readBounded(path: string, maxBytes: number): ReadOutcome {
  try {
    if (statSync(path).size > maxBytes) return { ok: false, reason: "too-large" };
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** The real filesystem, wrapped so detection cannot see anything wider. */
const NODE_DETECTION_PORT: DetectionPort = {
  exists: (path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  },
  readDirectory: (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  readTextFile: (path, maxBytes) => {
    const outcome = readBounded(path, maxBytes);
    return outcome.ok ? outcome.text : null;
  },
  join: (...parts) => join(...parts)
};

/* ------------------------------------------------------------------------- */
/* The manager                                                                */
/* ------------------------------------------------------------------------- */

export class MigrationManager {
  private readonly bookmarks: BookmarkStore;
  private readonly vault: StagedPasswordVault;
  private readonly state: MigrationStateStore;
  private readonly environment: RegistryEnvironment;
  private readonly dialog: MigrationDialogPort;
  private readonly cipher: CipherPort;
  private readonly now: () => number;
  private readonly port: DetectionPort;

  private readonly handles = new Map<string, HandleEntry>();
  private detection: DetectionResult | null = null;

  public constructor(options: MigrationManagerOptions, port: DetectionPort = NODE_DETECTION_PORT) {
    this.bookmarks = new BookmarkStore({
      path: join(options.userDataDir, "bookmarks.json")
    });
    this.vault = new StagedPasswordVault({
      path: join(options.userDataDir, "staged-passwords.enc"),
      cipher: options.cipher
    });
    this.state = new MigrationStateStore({
      path: join(options.userDataDir, "migration.json")
    });

    this.environment = options.environment;
    this.dialog = options.dialog;
    this.cipher = options.cipher;
    this.now = options.now ?? ((): number => Date.now());
    this.port = port;
  }

  /* --------------------------------------------------------------------- */
  /* Queries                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * Everything the wizard needs to open.
   *
   * Detection runs here rather than at startup: a browser list is only worth
   * gathering when someone is about to be shown one, and doing it lazily keeps
   * launch from touching another application's directories at all.
   */
  public overview(): MigrationOverview {
    return {
      state: this.state.read(),
      encryption: this.encryptionState(),
      sources: this.detect().browsers,
      stagedPasswordCount: this.safeStagedCount(),
      storedBookmarkCount: this.safeBookmarkCount()
    };
  }

  private encryptionState(): EncryptionState {
    try {
      return this.cipher.availability();
    } catch {
      return "unavailable";
    }
  }

  private detect(): DetectionResult {
    if (this.detection !== null) return this.detection;

    const candidates = sourceCandidates(this.environment, this.port);
    const result = detectBrowsers(candidates, this.port);
    this.detection = result;
    return result;
  }

  private safeStagedCount(): number {
    try {
      return this.vault.count();
    } catch {
      return 0;
    }
  }

  /**
   * Searches the imported bookmarks.
   *
   * The search runs here rather than in the renderer because the store holds up
   * to fifty thousand entries and none of them needs to cross IPC to be
   * filtered. What goes back is a bounded page and a total, so the chrome can
   * say "showing 200 of 4,000" without ever holding the four thousand.
   *
   * Labels are re-cleaned on the way out. They were cleaned at import, but the
   * file is on disk and could have been edited since, and the store's own read
   * already re-applies the scheme gate for the same reason.
   */
  public searchBookmarks(query: string): BookmarkPage {
    let stored: readonly ImportedBookmark[];
    try {
      stored = this.bookmarks.read();
    } catch {
      return emptyBookmarkPage();
    }

    const matched: BookmarkEntry[] = [];

    for (const bookmark of stored) {
      const entry: BookmarkEntry = {
        title: bookmarkLabel(bookmark.title),
        url: bookmark.url,
        folder: bookmarkLabel(bookmark.folderPath.join(" / "))
      };

      if (matchesBookmarkQuery(entry, query)) matched.push(entry);
    }

    return {
      entries: matched.slice(0, MAX_BOOKMARK_RESULTS),
      total: matched.length,
      truncated: matched.length > MAX_BOOKMARK_RESULTS
    };
  }

  private safeBookmarkCount(): number {
    try {
      return this.bookmarks.count();
    } catch {
      return 0;
    }
  }

  /* --------------------------------------------------------------------- */
  /* Previews                                                              */
  /* --------------------------------------------------------------------- */

  /**
   * Reads one detected profile for review.
   *
   * This is the first moment any bookmark data is touched, and it happens only
   * because the user named this source and this profile. An id the registry did
   * not mint throws, so a renderer cannot reach a file by inventing one.
   */
  public previewChromiumProfile(payload: MigrationPreviewPayload): BookmarkPreviewResponse {
    const resolved = this.detect().resolved.get(
      profileKey(payload.sourceId, payload.profileId)
    );

    if (resolved === undefined) {
      // Deliberately does not distinguish "no such browser" from "no such
      // profile": both are the same answer to a renderer that guessed.
      throw new Error("Unknown migration source.");
    }

    const warnings = new WarningLedger();
    let bookmarks: readonly ImportedBookmark[] = [];
    let folderCount = 0;

    if (resolved.bookmarksPath === null) {
      warnings.add("profile-unreadable");
    } else {
      const outcome = readBounded(resolved.bookmarksPath, MAX_BOOKMARK_FILE_BYTES);
      if (!outcome.ok) {
        warnings.add(outcome.reason === "too-large" ? "file-too-large" : "file-unreadable");
      } else {
        const parsed = parseChromiumBookmarks(outcome.text);
        bookmarks = parsed.bookmarks;
        folderCount = parsed.folderCount;
        for (const warning of parsed.warnings) warnings.add(warning.code, warning.count);
      }
    }

    const searchName = this.readSearchName(resolved.preferencesPath, warnings);

    return this.mintBookmarkHandle({
      sourceKind: "chromium",
      sourceId: payload.sourceId,
      profileId: payload.profileId,
      bookmarks,
      folderCount,
      searchName,
      warnings
    });
  }

  /**
   * Reads the configured search engine's display name.
   *
   * The preferences file is opened for exactly one string. Everything else it
   * contains — sign-in state, sync settings, extension configuration, the search
   * URL template itself — is parsed past and discarded by `parseChromiumSearchName`,
   * whose return type is a name.
   */
  private readSearchName(path: string | null, warnings: WarningLedger): string | null {
    if (path === null) {
      warnings.add("search-name-unavailable");
      return null;
    }

    const outcome = readBounded(path, MAX_BOOKMARK_FILE_BYTES);
    if (!outcome.ok) {
      warnings.add("search-name-unavailable");
      return null;
    }

    const name = parseChromiumSearchName(outcome.text);
    if (name === null) warnings.add("search-name-unavailable");
    return name;
  }

  /**
   * Opens a native picker for an exported bookmark file.
   *
   * This is the whole of the Firefox and Safari story. Their live databases are
   * never opened: the user exports, picks the export, and the parser sees a file
   * they deliberately handed over.
   */
  public async pickHtmlBookmarks(kind: HtmlSourceKind): Promise<PickedBookmarkFile> {
    const path = await this.dialog.openFile({
      title:
        kind === "firefox-html"
          ? "Choose an exported Firefox bookmarks file"
          : "Choose an exported Safari bookmarks file",
      buttonLabel: "Review bookmarks",
      filterName: "Bookmark export",
      extensions: ["html", "htm"]
    });

    if (path === null) return { cancelled: true, result: null };

    const warnings = new WarningLedger();
    let bookmarks: readonly ImportedBookmark[] = [];
    let folderCount = 0;

    // The dialog's filter is advisory on some platforms, so the extension is
    // checked again here rather than assumed.
    if (!BOOKMARK_EXTENSIONS.includes(extname(path).toLowerCase())) {
      warnings.add("file-malformed");
    } else {
      const outcome = readBounded(path, MAX_BOOKMARK_FILE_BYTES);
      if (!outcome.ok) {
        warnings.add(outcome.reason === "too-large" ? "file-too-large" : "file-unreadable");
      } else {
        const parsed = parseHtmlBookmarks(outcome.text);
        bookmarks = parsed.bookmarks;
        folderCount = parsed.folderCount;
        for (const warning of parsed.warnings) warnings.add(warning.code, warning.count);
      }
    }

    return {
      cancelled: false,
      result: this.mintBookmarkHandle({
        sourceKind: kind,
        sourceId: null,
        profileId: null,
        bookmarks,
        folderCount,
        searchName: null,
        warnings
      })
    };
  }

  /**
   * Opens a native picker for a password export and parses it for review.
   *
   * The parsed credentials stay in this process against the returned handle.
   * What crosses back is counts, recognised column names, and warning codes — and
   * the column names only when the first row was recognisably a header.
   */
  public async pickPasswordCsv(): Promise<PickedPasswordFile> {
    const path = await this.dialog.openFile({
      title: "Choose a password export to review",
      buttonLabel: "Review passwords",
      filterName: "Password export",
      extensions: ["csv"]
    });

    if (path === null) return { cancelled: true, result: null };

    const warnings = new WarningLedger();

    if (!CSV_EXTENSIONS.includes(extname(path).toLowerCase())) {
      return {
        cancelled: false,
        result: {
          handle: this.mintHandle({ kind: "password", records: [], expiresAt: this.expiry() }),
          preview: {
            totalRows: 0,
            validRows: 0,
            rejectedRows: 0,
            detectedColumns: [],
            warnings: [{ code: "file-malformed", count: 0 }]
          }
        }
      };
    }

    const outcome = readBounded(path, MAX_CSV_FILE_BYTES);
    if (!outcome.ok) {
      warnings.add(outcome.reason === "too-large" ? "file-too-large" : "file-unreadable");
      return {
        cancelled: false,
        result: {
          handle: this.mintHandle({ kind: "password", records: [], expiresAt: this.expiry() }),
          preview: {
            totalRows: 0,
            validRows: 0,
            rejectedRows: 0,
            detectedColumns: [],
            warnings: warnings.list()
          }
        }
      };
    }

    const parsed = parsePasswordCsv(outcome.text);

    return {
      cancelled: false,
      result: {
        handle: this.mintHandle({
          kind: "password",
          records: parsed.records,
          expiresAt: this.expiry()
        }),
        preview: parsed.preview
      }
    };
  }

  /* --------------------------------------------------------------------- */
  /* Commit                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * Performs exactly the categories the user confirmed.
   *
   * Ordering is deliberate: bookmarks, then the search name, then passwords.
   * Each step is independent, and a step that cannot run records why rather than
   * abandoning the steps that already succeeded — a user who has just imported
   * two thousand bookmarks must not be told the migration failed because their
   * system has no keychain.
   *
   * Handles are consumed here. Committing twice with the same handle is not a
   * duplicate import; the second attempt finds nothing and is rejected.
   */
  public commit(payload: MigrationCommitPayload): MigrationResult {
    const bookmarkEntry = this.takeBookmarkHandle(payload);
    const passwordEntry = this.takePasswordHandle(payload);

    const warnings = new WarningLedger();
    let importedBookmarkCount = 0;
    let importedFolderCount = 0;
    let skippedDuplicateCount = 0;

    if (payload.importBookmarks && bookmarkEntry !== null) {
      try {
        const committed = this.bookmarks.commit(bookmarkEntry.bookmarks, {
          deduplicate: payload.deduplicate
        });
        importedBookmarkCount = committed.added;
        importedFolderCount = committed.folderCount;
        skippedDuplicateCount = committed.skippedDuplicates;
        for (const warning of committed.warnings) warnings.add(warning.code, warning.count);
      } catch {
        // The atomic write left the previous set intact, so nothing partial is
        // on disk and the result reports honestly that nothing was added.
        warnings.add("file-unreadable");
      }
    }

    const searchName =
      payload.importDefaultSearchName && bookmarkEntry !== null ? bookmarkEntry.searchName : null;
    const importedSearchName = searchName !== null;
    if (payload.importDefaultSearchName && !importedSearchName) {
      warnings.add("search-name-unavailable");
    }

    let stagedPasswordCount = 0;
    if (payload.stagePasswords && passwordEntry !== null) {
      try {
        stagedPasswordCount = this.vault.stage(passwordEntry.records);
      } catch (error) {
        // The refusal is the feature. It is reported, not worked around.
        if (error instanceof StagedPasswordStorageUnavailableError) {
          warnings.add("encryption-unavailable");
        } else {
          warnings.add("file-unreadable");
        }
      }
    }

    this.recordCommit({
      sourceKind: payload.stagePasswords && !payload.importBookmarks
        ? "password-csv"
        : (bookmarkEntry?.sourceKind ?? "password-csv"),
      importedBookmarkCount,
      importedFolderCount,
      importedSearchName,
      searchName,
      stagedPasswordCount
    });

    return {
      importedBookmarkCount,
      importedFolderCount,
      skippedDuplicateCount,
      importedSearchName,
      searchName,
      stagedPasswordCount,
      warnings: warnings.list()
    };
  }

  private recordCommit(summary: {
    readonly sourceKind: MigrationStateRecord["lastSourceKind"];
    readonly importedBookmarkCount: number;
    readonly importedFolderCount: number;
    readonly importedSearchName: boolean;
    readonly searchName: string | null;
    readonly stagedPasswordCount: number;
  }): void {
    const previous = this.state.read();
    const timestamp = this.now();

    this.state.write({
      ...previous,
      status: "completed",
      updatedAt: timestamp,
      completedAt: timestamp,
      runCount: previous.runCount + 1,
      lastSourceKind: summary.sourceKind,
      importedBookmarks: previous.importedBookmarks || summary.importedBookmarkCount > 0,
      importedDefaultSearchName:
        previous.importedDefaultSearchName || summary.importedSearchName,
      defaultSearchName: summary.importedSearchName
        ? (summary.searchName?.slice(0, MAX_SEARCH_NAME_LENGTH) ?? previous.defaultSearchName)
        : previous.defaultSearchName,
      stagedPasswords: previous.stagedPasswords || summary.stagedPasswordCount > 0,
      totalBookmarkCount: this.safeBookmarkCount(),
      totalFolderCount: previous.totalFolderCount + summary.importedFolderCount,
      stagedPasswordCount: this.safeStagedCount()
    });
  }

  /* --------------------------------------------------------------------- */
  /* Wizard lifecycle                                                      */
  /* --------------------------------------------------------------------- */

  /**
   * Chooses a fresh profile.
   *
   * Recorded as `dismissed` rather than `completed`: nothing was imported, and
   * the difference matters to anyone reading the state later.
   */
  public startFresh(): MigrationOverview {
    this.releaseAll();

    const previous = this.state.read();
    this.state.write({ ...previous, status: "dismissed", updatedAt: this.now() });
    return this.overview();
  }

  /** Marks the wizard finished after a committed run. */
  public finish(): MigrationOverview {
    this.releaseAll();
    return this.overview();
  }

  /**
   * Abandons the wizard.
   *
   * Every staged handle is dropped, which is what releases the parsed bookmarks
   * and — importantly — the parsed credentials. No state is written, so a
   * cancelled wizard is indistinguishable from one that was never opened.
   */
  public cancel(): MigrationOverview {
    this.releaseAll();
    return this.overview();
  }

  /** Drops one reviewed selection, for a wizard stepping back a screen. */
  public releaseHandle(handle: string): void {
    this.handles.delete(handle);
  }

  /** Re-opens the wizard from Settings. */
  public reopen(): MigrationOverview {
    this.releaseAll();

    const previous = this.state.read();
    this.state.write({ ...previous, status: "pending", updatedAt: this.now() });
    return this.overview();
  }

  /**
   * Removes every staged credential.
   *
   * Deliberately unconditional and always available, including when the platform
   * can no longer decrypt what it once wrote: being unable to read a secret is
   * no reason to be unable to delete it.
   */
  public deleteStagedPasswords(): MigrationOverview {
    try {
      this.vault.deleteAll();
    } catch {
      // Reported by the count in the overview rather than claimed as removed.
    }

    const previous = this.state.read();
    this.state.write({
      ...previous,
      updatedAt: this.now(),
      stagedPasswords: false,
      stagedPasswordCount: this.safeStagedCount()
    });

    return this.overview();
  }

  /** Called at teardown. Drops parsed bookmarks and credentials from memory. */
  public destroy(): void {
    this.releaseAll();
    this.detection = null;
  }

  /* --------------------------------------------------------------------- */
  /* Handles                                                               */
  /* --------------------------------------------------------------------- */

  private expiry(): number {
    return this.now() + MIGRATION_HANDLE_TTL_MS;
  }

  private mintHandle(entry: HandleEntry): string {
    this.sweep();
    const handle = `mig-${randomUUID()}`;
    this.handles.set(handle, entry);
    return handle;
  }

  private mintBookmarkHandle(input: {
    readonly sourceKind: BookmarkSourceKind;
    readonly sourceId: string | null;
    readonly profileId: string | null;
    readonly bookmarks: readonly ImportedBookmark[];
    readonly folderCount: number;
    readonly searchName: string | null;
    readonly warnings: WarningLedger;
  }): BookmarkPreviewResponse {
    const warnings: readonly MigrationWarning[] = input.warnings.list();

    const handle = this.mintHandle({
      kind: "bookmark",
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      profileId: input.profileId,
      bookmarks: input.bookmarks,
      folderCount: input.folderCount,
      searchName: input.searchName,
      expiresAt: this.expiry()
    });

    return {
      handle,
      kind: input.sourceKind,
      preview: {
        ...toBookmarkPreview({
          bookmarks: input.bookmarks,
          folderCount: input.folderCount,
          warnings: []
        }),
        warnings
      },
      defaultSearchName: input.searchName
    };
  }

  /**
   * Resolves and consumes the bookmark handle a commit named.
   *
   * The source and profile the renderer sent are checked against what the handle
   * actually holds, so a payload that names one profile while carrying another's
   * review is refused rather than quietly importing the wrong one.
   */
  private takeBookmarkHandle(payload: MigrationCommitPayload): BookmarkHandleEntry | null {
    if (payload.bookmarkHandle === null) return null;

    const entry = this.consume(payload.bookmarkHandle);
    if (entry === null || entry.kind !== "bookmark") {
      throw new Error("The reviewed bookmark selection is no longer available.");
    }

    if (payload.sourceId !== null && payload.sourceId !== entry.sourceId) {
      throw new Error("The reviewed bookmark selection does not match the named source.");
    }
    if (payload.profileId !== null && payload.profileId !== entry.profileId) {
      throw new Error("The reviewed bookmark selection does not match the named profile.");
    }
    if (payload.importDefaultSearchName && entry.sourceKind !== "chromium") {
      throw new Error("A search engine name can only be imported from a browser profile.");
    }

    return entry;
  }

  private takePasswordHandle(payload: MigrationCommitPayload): PasswordHandleEntry | null {
    if (payload.passwordHandle === null) return null;

    const entry = this.consume(payload.passwordHandle);
    if (entry === null || entry.kind !== "password") {
      throw new Error("The reviewed password selection is no longer available.");
    }

    return entry;
  }

  private consume(handle: string): HandleEntry | null {
    this.sweep();

    const entry = this.handles.get(handle);
    if (entry === undefined) return null;

    this.handles.delete(handle);
    return entry;
  }

  /** Drops selections the user reviewed but never acted on. */
  private sweep(): void {
    const now = this.now();
    for (const [handle, entry] of this.handles) {
      if (entry.expiresAt <= now) this.handles.delete(handle);
    }
  }

  private releaseAll(): void {
    this.handles.clear();
  }
}
