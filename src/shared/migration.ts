/**
 * Migration contracts shared by the trusted process and the chrome.
 *
 * Migration is the one feature that deliberately reads another application's
 * data, so the contracts are written to make the privacy promise structural
 * rather than procedural:
 *
 *   - Nothing here can carry a local path. The renderer names a *source* by an
 *     app-minted identifier, or names a file the user picked through a native
 *     dialog by an opaque handle the trusted process minted. There is no field
 *     an absolute path fits into.
 *   - Nothing here can carry a password. The CSV preview reports counts and
 *     recognised column names; the result reports a staged count. Neither shape
 *     has a slot for a value.
 *   - Warnings are codes with counts, not free text. A parser cannot accidentally
 *     interpolate a bookmark title, a URL, or a CSV cell into a message that
 *     ends up in the renderer, a log, or persisted state.
 *
 * Categories that are never migrated — cookies, sessions, account tokens,
 * passkeys, payment data, extensions and their settings — have no representation
 * anywhere in this file. That absence is the guarantee.
 */

import type { EncryptionState } from "./agents.js";
import {
  MAX_URL_LENGTH,
  optional,
  requireBoolean,
  requireIdentifier,
  requireOneOf,
  requirePlainObject,
  IpcValidationError
} from "./ipc-validation.js";

/* ------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The four paths a migration can take.
 *
 * Firefox and Safari appear only as `-html` because OpenStrawberry never opens
 * their internal databases. `password-csv` is its own kind rather than a
 * category of the others, because staging credentials is a separate reviewed act
 * and must never ride along with a bookmark import.
 */
export const MIGRATION_SOURCE_KINDS = [
  "chromium",
  "firefox-html",
  "safari-html",
  "password-csv"
] as const;
export type MigrationSourceKind = (typeof MIGRATION_SOURCE_KINDS)[number];

/** Bookmark-bearing kinds. `password-csv` is deliberately not one of them. */
export const BOOKMARK_SOURCE_KINDS = [
  "chromium",
  "firefox-html",
  "safari-html"
] as const;
export type BookmarkSourceKind = (typeof BOOKMARK_SOURCE_KINDS)[number];

/** The kinds reached through a manual export file rather than a detected profile. */
export const HTML_SOURCE_KINDS = ["firefox-html", "safari-html"] as const;
export type HtmlSourceKind = (typeof HTML_SOURCE_KINDS)[number];

export const BROWSER_FAMILIES = ["chromium", "firefox", "safari"] as const;
export type BrowserFamily = (typeof BROWSER_FAMILIES)[number];

/* ------------------------------------------------------------------------- */
/* Limits                                                                     */
/* ------------------------------------------------------------------------- */

/*
 * Every limit below exists because the file being read was written by another
 * program and may have been edited by anyone. A parser that trusts its input to
 * be small, shallow, or well formed is a denial-of-service waiting to happen in
 * the one process that must not fall over.
 */

/** A very large Chromium bookmark file is a few megabytes; this is generous. */
export const MAX_BOOKMARK_FILE_BYTES = 32 * 1024 * 1024;
/** A password export of tens of thousands of rows stays well under this. */
export const MAX_CSV_FILE_BYTES = 8 * 1024 * 1024;

export const MAX_BOOKMARK_RECORDS = 20_000;
export const MAX_BOOKMARK_FOLDERS = 2_000;
/** Bounds recursion in the Chromium tree and nesting in an HTML export. */
export const MAX_BOOKMARK_DEPTH = 16;
export const MAX_BOOKMARK_TITLE_LENGTH = 512;
export const MAX_BOOKMARK_URL_LENGTH = MAX_URL_LENGTH;
export const MAX_FOLDER_NAME_LENGTH = 128;

export const MAX_CSV_ROWS = 20_000;
export const MAX_CSV_COLUMNS = 32;
export const MAX_CSV_FIELD_LENGTH = 4096;
/** Column names come from the file, so they are bounded like any other input. */
export const MAX_COLUMN_NAME_LENGTH = 40;

/** How much of a bookmark set the review screen may show at once. */
export const MAX_PREVIEW_SAMPLE = 8;
/** A sample entry is for recognition, not for reading the whole title. */
export const MAX_SAMPLE_TITLE_LENGTH = 96;
export const MAX_SAMPLE_URL_LENGTH = 128;

/** A search provider's display name: "Google", "DuckDuckGo", "Startpage". */
export const MAX_SEARCH_NAME_LENGTH = 64;

export const MAX_DETECTED_BROWSERS = 16;
export const MAX_PROFILES_PER_BROWSER = 24;

/** Bounds the app-owned bookmark store so an import cannot grow it without end. */
export const MAX_STORED_BOOKMARKS = 50_000;

/**
 * How long a staged file selection stays usable.
 *
 * A handle holds a path the user chose and, for a CSV, the parsed rows. Both are
 * dropped when the wizard finishes or cancels; this bound is the backstop for a
 * wizard that is simply left open.
 */
export const MIGRATION_HANDLE_TTL_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------------- */
/* Warnings                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Everything a migration can report going wrong, as a closed set of codes.
 *
 * This is deliberately not `string[]`. A free-text warning is one careless
 * template literal away from carrying a bookmark title, a URL, a CSV cell, or a
 * profile path into the renderer and the log. A code plus a count cannot.
 */
export const MIGRATION_WARNING_CODES = [
  "file-too-large",
  "file-unreadable",
  "file-malformed",
  "bookmarks-truncated",
  "folders-truncated",
  "malformed-entries-skipped",
  "unsafe-url-skipped",
  "oversized-entry-skipped",
  "depth-limit-reached",
  "duplicates-skipped",
  "no-bookmarks-found",
  "search-name-unavailable",
  "profile-unreadable",
  "csv-headers-unrecognised",
  "csv-missing-url-column",
  "csv-missing-username-column",
  "csv-missing-password-column",
  "csv-malformed-rows-skipped",
  "csv-truncated",
  "csv-empty",
  "encryption-unavailable",
  "store-limit-reached"
] as const;
export type MigrationWarningCode = (typeof MIGRATION_WARNING_CODES)[number];

export interface MigrationWarning {
  readonly code: MigrationWarningCode;
  /** How many records the code applies to. Zero means "not a per-record fact". */
  readonly count: number;
}

/** Bounds a warning list; the codes are a closed set, so this is never large. */
export const MAX_WARNINGS = MIGRATION_WARNING_CODES.length;

const WARNING_TEXT: Readonly<Record<MigrationWarningCode, string>> = {
  "file-too-large": "The file is larger than OpenStrawberry will read, so it was not parsed.",
  "file-unreadable": "The file could not be read. It may be locked by another program.",
  "file-malformed": "The file is not in the expected format, so nothing was read from it.",
  "bookmarks-truncated": "Reading stopped at the bookmark limit; later entries were not read.",
  "folders-truncated": "Reading stopped at the folder limit; later folders were not read.",
  "malformed-entries-skipped": "Entries that were not well formed were skipped.",
  "unsafe-url-skipped": "Entries using a scheme other than http or https were skipped.",
  "oversized-entry-skipped": "Entries with an over-long title or address were skipped.",
  "depth-limit-reached": "Folders nested deeper than the limit were not read.",
  "duplicates-skipped": "Bookmarks already saved in the same folder were skipped.",
  "no-bookmarks-found": "No bookmarks were found in this source.",
  "search-name-unavailable": "The configured search engine name could not be read.",
  "profile-unreadable": "This profile could not be read. It may be in use or restricted.",
  "csv-headers-unrecognised":
    "No recognisable column names were found, so no column names are shown and no rows were accepted.",
  "csv-missing-url-column": "No address column was recognised.",
  "csv-missing-username-column": "No username column was recognised.",
  "csv-missing-password-column": "No password column was recognised.",
  "csv-malformed-rows-skipped": "Rows that were not well formed were skipped.",
  "csv-truncated": "Reading stopped at the row limit; later rows were not read.",
  "csv-empty": "The file contained no rows.",
  "encryption-unavailable":
    "This system has no operating-system encryption available, so nothing was staged.",
  "store-limit-reached": "The saved bookmark limit was reached; later entries were not saved."
};

export function describeWarning(warning: MigrationWarning): string {
  return WARNING_TEXT[warning.code];
}

/** Collects warnings without repeating a code, summing counts instead. */
export class WarningLedger {
  private readonly counts = new Map<MigrationWarningCode, number>();

  public add(code: MigrationWarningCode, count = 0): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + count);
  }

  public has(code: MigrationWarningCode): boolean {
    return this.counts.has(code);
  }

  public list(): readonly MigrationWarning[] {
    return [...this.counts].map(([code, count]) => ({ code, count }));
  }
}

/* ------------------------------------------------------------------------- */
/* Detection                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * One profile inside a detected browser.
 *
 * `id` is an app-minted handle, never a directory name the trusted process would
 * later join onto a path from renderer input: the registry resolves it back to a
 * location itself, so a renderer that invents an id gets a rejection rather than
 * a file read.
 */
export interface DetectedProfile {
  readonly id: string;
  readonly displayName: string;
  readonly supportsBookmarkRead: boolean;
  readonly supportsSearchNameRead: boolean;
}

export interface DetectedBrowser {
  readonly id: string;
  readonly displayName: string;
  readonly family: BrowserFamily;
  readonly profiles: readonly DetectedProfile[];
}

/* ------------------------------------------------------------------------- */
/* Previews                                                                   */
/* ------------------------------------------------------------------------- */

/** One line of the review screen's sample. Bounded for display, not for import. */
export interface BookmarkSample {
  readonly title: string;
  readonly url: string;
}

export interface BookmarkPreview {
  readonly folderCount: number;
  readonly bookmarkCount: number;
  readonly sample: readonly BookmarkSample[];
  readonly warnings: readonly MigrationWarning[];
}

/**
 * What review is allowed to know about a password file.
 *
 * `detectedColumns` holds recognised header names only, and is empty whenever the
 * header row was not recognised as a header — a file with no header row would
 * otherwise put a real credential into this field.
 */
export interface PasswordCsvPreview {
  readonly totalRows: number;
  readonly validRows: number;
  readonly rejectedRows: number;
  readonly detectedColumns: readonly string[];
  readonly warnings: readonly MigrationWarning[];
}

export interface BookmarkPreviewResponse {
  /** Opaque, main-minted, and the only way to refer to the reviewed file. */
  readonly handle: string;
  readonly kind: BookmarkSourceKind;
  readonly preview: BookmarkPreview;
  /** Display name only. Never a URL template, key, or account detail. */
  readonly defaultSearchName: string | null;
}

export interface PasswordPreviewResponse {
  readonly handle: string;
  readonly preview: PasswordCsvPreview;
}

/**
 * The result of a native file dialog.
 *
 * Dismissing the dialog is an ordinary outcome, not an error, so it comes back
 * as a flag rather than a rejection the wizard would have to render as a fault.
 */
export interface PickedBookmarkFile {
  readonly cancelled: boolean;
  readonly result: BookmarkPreviewResponse | null;
}

export interface PickedPasswordFile {
  readonly cancelled: boolean;
  readonly result: PasswordPreviewResponse | null;
}

/* ------------------------------------------------------------------------- */
/* Selection and result                                                       */
/* ------------------------------------------------------------------------- */

/**
 * What the user chose, category by category.
 *
 * Every field defaults to off. There is no "import everything" value, because
 * there is no point in the flow where a category is selected on the user's
 * behalf.
 */
export interface MigrationSelection {
  readonly sourceId: string | null;
  readonly profileId: string | null;
  readonly importBookmarks: boolean;
  readonly importDefaultSearchName: boolean;
  readonly stagePasswords: boolean;
}

export function emptySelection(): MigrationSelection {
  return {
    sourceId: null,
    profileId: null,
    importBookmarks: false,
    importDefaultSearchName: false,
    stagePasswords: false
  };
}

export function hasAnyCategory(selection: MigrationSelection): boolean {
  return (
    selection.importBookmarks ||
    selection.importDefaultSearchName ||
    selection.stagePasswords
  );
}

/**
 * What actually happened. Counts and warnings only.
 *
 * `searchName` is the provider display name the user already read on the review
 * screen, echoed back so the result screen can name what was set. There is no
 * field for a password, a URL template, or a source location.
 */
export interface MigrationResult {
  readonly importedBookmarkCount: number;
  readonly importedFolderCount: number;
  readonly skippedDuplicateCount: number;
  readonly importedSearchName: boolean;
  readonly searchName: string | null;
  readonly stagedPasswordCount: number;
  readonly warnings: readonly MigrationWarning[];
}

export function emptyResult(): MigrationResult {
  return {
    importedBookmarkCount: 0,
    importedFolderCount: 0,
    skippedDuplicateCount: 0,
    importedSearchName: false,
    searchName: null,
    stagedPasswordCount: 0,
    warnings: []
  };
}

/* ------------------------------------------------------------------------- */
/* Persisted state                                                            */
/* ------------------------------------------------------------------------- */

export const MIGRATION_STATE_VERSION = 1;

/**
 * `pending` shows the wizard on launch. `dismissed` is the user choosing a fresh
 * profile, and `completed` is a migration that ran. Neither of the last two
 * reopens on its own; Settings is the only way back in.
 */
export const MIGRATION_STATUSES = ["pending", "completed", "dismissed"] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/**
 * The application-owned record of what migration has done.
 *
 * Flat by design: there is no nested object for "the source", because that is
 * where a path or a profile name would eventually be added. What is kept is the
 * category of source, the categories chosen, and totals.
 */
export interface MigrationStateRecord {
  readonly version: number;
  readonly status: MigrationStatus;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  /** How many times a migration has been committed. Drives the duplicate notice. */
  readonly runCount: number;
  readonly lastSourceKind: MigrationSourceKind | null;
  readonly importedBookmarks: boolean;
  readonly importedDefaultSearchName: boolean;
  /**
   * The search provider's display name, as read for review and confirmed.
   *
   * The name and nothing else. There is deliberately no sibling field for the
   * URL template, the suggestion endpoint, or the keyword, so importing a search
   * engine cannot grow into importing a search configuration.
   */
  readonly defaultSearchName: string | null;
  readonly stagedPasswords: boolean;
  readonly totalBookmarkCount: number;
  readonly totalFolderCount: number;
  readonly stagedPasswordCount: number;
}

/** Bounds a persisted timestamp to something a real clock could produce. */
const MAX_TIMESTAMP = 4_102_444_800_000;

export function emptyMigrationState(): MigrationStateRecord {
  return {
    version: MIGRATION_STATE_VERSION,
    status: "pending",
    updatedAt: 0,
    completedAt: null,
    runCount: 0,
    lastSourceKind: null,
    importedBookmarks: false,
    importedDefaultSearchName: false,
    defaultSearchName: null,
    stagedPasswords: false,
    totalBookmarkCount: 0,
    totalFolderCount: 0,
    stagedPasswordCount: 0
  };
}

function boundedCount(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  if (value < 0) return 0;
  return value > max ? max : value;
}

function boundedTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  if (value < 0 || value > MAX_TIMESTAMP) return 0;
  return value;
}

function boundedFlag(value: unknown): boolean {
  return value === true;
}

/**
 * Reads a state file written by an earlier run.
 *
 * The file is on disk and could have been edited, so an unknown version, a
 * missing field, or an out-of-range number yields the empty state rather than
 * throwing. A damaged file means the wizard offers itself again, which is
 * recoverable; a throw here would wedge startup, which is not.
 */
export function parseMigrationState(raw: unknown): MigrationStateRecord {
  try {
    const root = requirePlainObject(raw, "Migration state");
    if (root["version"] !== MIGRATION_STATE_VERSION) return emptyMigrationState();

    const status = root["status"];
    const kind = root["lastSourceKind"];
    const completedAt = boundedTimestamp(root["completedAt"]);
    const searchName = root["defaultSearchName"];

    return {
      version: MIGRATION_STATE_VERSION,
      status:
        typeof status === "string" && (MIGRATION_STATUSES as readonly string[]).includes(status)
          ? (status as MigrationStatus)
          : "pending",
      updatedAt: boundedTimestamp(root["updatedAt"]),
      completedAt: completedAt === 0 ? null : completedAt,
      runCount: boundedCount(root["runCount"], 10_000),
      lastSourceKind:
        typeof kind === "string" && (MIGRATION_SOURCE_KINDS as readonly string[]).includes(kind)
          ? (kind as MigrationSourceKind)
          : null,
      importedBookmarks: boundedFlag(root["importedBookmarks"]),
      importedDefaultSearchName: boundedFlag(root["importedDefaultSearchName"]),
      defaultSearchName:
        typeof searchName === "string" && searchName.length > 0
          ? searchName.slice(0, MAX_SEARCH_NAME_LENGTH)
          : null,
      stagedPasswords: boundedFlag(root["stagedPasswords"]),
      totalBookmarkCount: boundedCount(root["totalBookmarkCount"], MAX_STORED_BOOKMARKS),
      totalFolderCount: boundedCount(root["totalFolderCount"], MAX_BOOKMARK_FOLDERS),
      stagedPasswordCount: boundedCount(root["stagedPasswordCount"], MAX_CSV_ROWS)
    };
  } catch {
    return emptyMigrationState();
  }
}

/* ------------------------------------------------------------------------- */
/* Overview                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Everything the wizard needs to open, in one read.
 *
 * `encryption` is the same vocabulary the credential store uses, so the wizard
 * can disable password staging for exactly the reason the agent panel disables
 * key entry, and say the same thing about it.
 */
export interface MigrationOverview {
  readonly state: MigrationStateRecord;
  readonly encryption: EncryptionState;
  readonly sources: readonly DetectedBrowser[];
  readonly stagedPasswordCount: number;
  readonly storedBookmarkCount: number;
}

export function shouldOfferWizard(state: MigrationStateRecord): boolean {
  return state.status === "pending";
}

/* ------------------------------------------------------------------------- */
/* Bookmark records and deduplication                                         */
/* ------------------------------------------------------------------------- */

/** One bookmark as every parser produces it and the store consumes it. */
export interface ImportedBookmark {
  readonly title: string;
  readonly url: string;
  /** Folder names from the root down. Empty means the top level. */
  readonly folderPath: readonly string[];
}

export interface BookmarkParseResult {
  readonly bookmarks: readonly ImportedBookmark[];
  readonly folderCount: number;
  readonly warnings: readonly MigrationWarning[];
}

/**
 * Reduces a URL to the form two bookmarks must share to count as the same one.
 *
 * Conservative on purpose. Scheme and host case and a default port carry no
 * meaning, and a fragment addresses a position within one page rather than a
 * different page, so those are normalised away. A query string is *not*: for a
 * great many sites it selects the content, and treating `?id=1` and `?id=2` as
 * one bookmark would silently drop something the user saved.
 *
 * Returns null for anything that is not an importable http(s) URL, which makes
 * this the single scheme gate every parser passes through.
 */
export function normalizeBookmarkUrl(url: string): string | null {
  if (url.length === 0 || url.length > MAX_BOOKMARK_URL_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;

  // Embedded credentials are refused here for the same reason navigation refuses
  // them: they are a phishing staple, and importing one would persist it.
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;

  parsed.hash = "";
  const path = parsed.pathname === "" ? "/" : parsed.pathname;
  const port = parsed.port.length > 0 ? `:${parsed.port}` : "";

  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}${path}${parsed.search}`;
}

/** True when a URL is safe to import at all. Rejects javascript:, data:, file:. */
export function isImportableBookmarkUrl(url: string): boolean {
  return normalizeBookmarkUrl(url) !== null;
}

/**
 * The identity of a bookmark for deduplication: same address, same folder.
 *
 * Folder-sensitive on purpose. The same page filed under two folders is two
 * deliberate acts of filing, and collapsing them would quietly discard one.
 */
export function bookmarkDedupeKey(bookmark: ImportedBookmark): string | null {
  const normalized = normalizeBookmarkUrl(bookmark.url);
  if (normalized === null) return null;

  const folder = bookmark.folderPath.map((part) => part.toLowerCase()).join(" ");
  return `${folder}${normalized}`;
}

/** Trims a title and address to what the review sample may show. */
export function toSample(bookmark: ImportedBookmark): BookmarkSample {
  const title =
    bookmark.title.length > MAX_SAMPLE_TITLE_LENGTH
      ? `${bookmark.title.slice(0, MAX_SAMPLE_TITLE_LENGTH - 1)}…`
      : bookmark.title;
  const url =
    bookmark.url.length > MAX_SAMPLE_URL_LENGTH
      ? `${bookmark.url.slice(0, MAX_SAMPLE_URL_LENGTH - 1)}…`
      : bookmark.url;

  return { title, url };
}

/** Builds the bounded preview a review screen renders from a parse result. */
export function toBookmarkPreview(parsed: BookmarkParseResult): BookmarkPreview {
  return {
    folderCount: parsed.folderCount,
    bookmarkCount: parsed.bookmarks.length,
    sample: parsed.bookmarks.slice(0, MAX_PREVIEW_SAMPLE).map(toSample),
    warnings: parsed.warnings
  };
}

/* ------------------------------------------------------------------------- */
/* IPC payload parsers                                                        */
/* ------------------------------------------------------------------------- */

function fail(message: string): never {
  throw new IpcValidationError(message);
}

export interface MigrationPreviewPayload {
  readonly sourceId: string;
  readonly profileId: string;
}

/**
 * Names a detected profile.
 *
 * Both halves are identifiers, not paths: the charset `requireIdentifier`
 * enforces contains no separator, so nothing that arrives here can be joined
 * into a location outside the registry's own entries. The registry still has to
 * resolve them, and rejects any id it did not mint.
 */
export function parseMigrationPreviewPayload(raw: unknown): MigrationPreviewPayload {
  const root = requirePlainObject(raw, "Migration preview payload");
  return {
    sourceId: requireIdentifier(root["sourceId"], "Source ID"),
    profileId: requireIdentifier(root["profileId"], "Profile ID")
  };
}

export interface HtmlPickPayload {
  readonly kind: HtmlSourceKind;
}

export function parseHtmlPickPayload(raw: unknown): HtmlPickPayload {
  const root = requirePlainObject(raw, "Bookmark file payload");
  return { kind: requireOneOf(root["kind"], HTML_SOURCE_KINDS, "Source kind") };
}

/**
 * A committed migration.
 *
 * The handles are the only reference to a file, and every category is checked
 * against the handle it needs. A payload asking to import bookmarks with no
 * reviewed bookmark file, or to stage passwords with no reviewed CSV, is
 * rejected here rather than being half-honoured downstream.
 */
export interface MigrationCommitPayload extends MigrationSelection {
  readonly bookmarkHandle: string | null;
  readonly passwordHandle: string | null;
  /** Skip bookmarks already saved under the same address and folder. */
  readonly deduplicate: boolean;
}

export function parseMigrationCommitPayload(raw: unknown): MigrationCommitPayload {
  const root = requirePlainObject(raw, "Migration commit payload");

  const sourceId = optional(root["sourceId"], "Source ID", requireIdentifier) ?? null;
  const profileId = optional(root["profileId"], "Profile ID", requireIdentifier) ?? null;
  const bookmarkHandle =
    optional(root["bookmarkHandle"], "Bookmark handle", requireIdentifier) ?? null;
  const passwordHandle =
    optional(root["passwordHandle"], "Password handle", requireIdentifier) ?? null;

  const payload: MigrationCommitPayload = {
    sourceId,
    profileId,
    bookmarkHandle,
    passwordHandle,
    importBookmarks: requireBoolean(root["importBookmarks"], "Bookmark selection"),
    importDefaultSearchName: requireBoolean(
      root["importDefaultSearchName"],
      "Search name selection"
    ),
    stagePasswords: requireBoolean(root["stagePasswords"], "Password selection"),
    deduplicate: requireBoolean(root["deduplicate"], "Deduplication choice")
  };

  if (!hasAnyCategory(payload)) fail("Migration selection must name at least one category.");

  if (payload.importBookmarks && bookmarkHandle === null) {
    fail("Bookmark import requires a reviewed bookmark file.");
  }
  if (payload.importDefaultSearchName && bookmarkHandle === null) {
    fail("Search name import requires a reviewed browser profile.");
  }
  if (payload.stagePasswords && passwordHandle === null) {
    fail("Password staging requires a reviewed password file.");
  }
  if (!payload.importBookmarks && !payload.importDefaultSearchName && bookmarkHandle !== null) {
    fail("Bookmark handle must not be sent when no bookmark category is selected.");
  }
  if (!payload.stagePasswords && passwordHandle !== null) {
    fail("Password handle must not be sent when password staging is not selected.");
  }
  // A profile is half a coordinate. One without the other names nothing.
  if ((sourceId === null) !== (profileId === null)) {
    fail("Source and profile must be named together.");
  }

  return payload;
}

export interface MigrationHandlePayload {
  readonly handle: string;
}

export function parseMigrationHandlePayload(raw: unknown): MigrationHandlePayload {
  const root = requirePlainObject(raw, "Migration handle payload");
  return { handle: requireIdentifier(root["handle"], "Handle") };
}
