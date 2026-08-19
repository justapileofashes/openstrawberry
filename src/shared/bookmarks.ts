/**
 * Reading the bookmark store the migration wizard writes.
 *
 * Migration already does the careful work: it parses another browser's export
 * under bounds, applies an http(s) gate, and commits atomically. This module is
 * the other half - the read path that makes any of that visible.
 *
 * One thing shapes the contract. The store holds up to fifty thousand entries,
 * which is far more than should ever cross IPC at once, so the search happens in
 * the trusted process and what comes back is a bounded page plus a count. The
 * renderer never holds the whole store, and a hostile renderer cannot ask it to.
 *
 * Pure ASCII, so the bounds stay reviewable.
 */

import { requirePlainObject, requireString } from "./ipc-validation.js";

/** How many entries one response may carry. A screen shows a few dozen. */
export const MAX_BOOKMARK_RESULTS = 200;

/** Bounds a search string before it reaches the store. */
export const MAX_BOOKMARK_QUERY_LENGTH = 128;

export const MAX_BOOKMARK_LABEL_LENGTH = 200;

/**
 * One bookmark, as the chrome shows it.
 *
 * `folder` is the folder path already joined for display. The renderer does not
 * reconstruct a tree: a flat, searchable list is what someone looking for a
 * saved page actually wants, and it keeps the payload a simple bounded array.
 */
export interface BookmarkEntry {
  readonly title: string;
  readonly url: string;
  readonly folder: string;
}

export interface BookmarkPage {
  readonly entries: readonly BookmarkEntry[];
  /** How many matched in total, which may exceed what was returned. */
  readonly total: number;
  /** True when the page is a prefix of a larger result. */
  readonly truncated: boolean;
}

export function emptyBookmarkPage(): BookmarkPage {
  return { entries: [], total: 0, truncated: false };
}

/** Control characters and bidi overrides, which have no place in a label. */
const UNSAFE_DISPLAY = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "gu"
);

/**
 * Reduces a stored label for display.
 *
 * Applied on read as well as at import. The file is on disk and could have been
 * edited since, so a title is re-cleaned rather than trusted because it was
 * cleaned once.
 */
export function bookmarkLabel(value: unknown, maxLength = MAX_BOOKMARK_LABEL_LENGTH): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE_DISPLAY, "").replace(/\s+/gu, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

/**
 * Whether an entry matches a search.
 *
 * Case-insensitive substring over the title, the address, and the folder path,
 * because all three are things someone remembers a page by. An empty query
 * matches everything, which is what makes the panel browsable before anyone
 * types.
 */
export function matchesBookmarkQuery(entry: BookmarkEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  return (
    entry.title.toLowerCase().includes(needle) ||
    entry.url.toLowerCase().includes(needle) ||
    entry.folder.toLowerCase().includes(needle)
  );
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface BookmarkQueryPayload {
  readonly query: string;
}

/**
 * Validates a search.
 *
 * An absent or empty query is the browsable default rather than an error, so the
 * panel can open without sending anything.
 */
export function parseBookmarkQueryPayload(raw: unknown): BookmarkQueryPayload {
  const root = requirePlainObject(raw, "Bookmark request");
  const query = root["query"];

  if (query === undefined || query === null) return { query: "" };

  return {
    query: requireString(query, "Bookmark query", MAX_BOOKMARK_QUERY_LENGTH)
  };
}
