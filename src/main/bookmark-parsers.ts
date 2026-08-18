/**
 * Parsers for the two bookmark formats OpenStrawberry will read.
 *
 * Both inputs were written by another program and may have been edited by
 * anyone, so both are treated as hostile: bounded size, bounded depth, bounded
 * record count, bounded field lengths, an http(s)-only scheme gate, and a
 * skip-and-count policy for anything malformed rather than a throw. A migration
 * that refuses the whole file because one entry is broken is a migration the
 * user cannot complete.
 *
 * These are pure string-to-result functions with no filesystem access of their
 * own, so the trusted process decides what to read and these decide only what a
 * given text means.
 */

import {
  MAX_BOOKMARK_DEPTH,
  MAX_BOOKMARK_FOLDERS,
  MAX_BOOKMARK_RECORDS,
  MAX_BOOKMARK_TITLE_LENGTH,
  MAX_BOOKMARK_URL_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  MAX_SEARCH_NAME_LENGTH,
  WarningLedger,
  isImportableBookmarkUrl,
  type BookmarkParseResult,
  type ImportedBookmark
} from "../shared/migration.js";

/**
 * Bounds the tag scan of an HTML export.
 *
 * The byte-size limit already bounds the file, but a file made entirely of empty
 * tags would still be a very long loop. This caps the work regardless of how the
 * bytes are arranged.
 */
const MAX_HTML_TOKENS = 500_000;

/* ------------------------------------------------------------------------- */
/* Shared text handling                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Reduces a title or folder name to something safe to store and display.
 *
 * Control characters are removed rather than escaped: they carry no meaning in a
 * bookmark title, and a stray newline or bidirectional override would corrupt
 * every list the title later appears in.
 */
function sanitizeText(value: string, maxLength: number): string {
  // C0 and C1 controls, plus the bidirectional overrides that let a title render
  // as a different string than the one that was stored.
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E]/gu, " ");
  const collapsed = stripped.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength).trim() : collapsed;
}

/** A bookmark with no name is filed under its host rather than shown as blank. */
function titleOrHost(title: string, url: string): string {
  if (title.length > 0) return title;
  try {
    return new URL(url).hostname;
  } catch {
    return "Untitled";
  }
}

/**
 * Collects bookmarks under the shared limits.
 *
 * Every parser funnels through this, so the scheme gate, the length bounds, the
 * record cap, and the warning codes cannot drift between the JSON path and the
 * HTML path.
 */
class BookmarkCollector {
  public readonly warnings = new WarningLedger();
  private readonly bookmarks: ImportedBookmark[] = [];
  private folders = 0;
  private unsafe = 0;
  private oversized = 0;
  private malformed = 0;

  public get count(): number {
    return this.bookmarks.length;
  }

  public get isFull(): boolean {
    return this.bookmarks.length >= MAX_BOOKMARK_RECORDS;
  }

  /**
   * True once the record cap is reached, recording that reading stopped early.
   *
   * Callers guard their loops with this rather than with `isFull`, so a walk
   * that abandons a subtree still reports the truncation. Checking `isFull`
   * alone would silently return a capped set that looks complete.
   */
  public stopHere(): boolean {
    if (!this.isFull) return false;
    this.warnings.add("bookmarks-truncated");
    return true;
  }

  public countFolder(): void {
    if (this.folders >= MAX_BOOKMARK_FOLDERS) {
      this.warnings.add("folders-truncated");
      return;
    }
    this.folders += 1;
  }

  public get folderCount(): number {
    return this.folders;
  }

  public malformedEntry(): void {
    this.malformed += 1;
  }

  /** Returns false once the record cap is reached, so callers can stop early. */
  public add(rawTitle: string, rawUrl: string, folderPath: readonly string[]): boolean {
    if (this.isFull) {
      this.warnings.add("bookmarks-truncated");
      return false;
    }

    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      this.malformed += 1;
      return true;
    }

    if (rawUrl.length > MAX_BOOKMARK_URL_LENGTH || rawTitle.length > MAX_BOOKMARK_TITLE_LENGTH * 4) {
      this.oversized += 1;
      return true;
    }

    // The single scheme gate. javascript:, data:, file:, and anything else that
    // is not http(s) leaves here and never reaches the store.
    if (!isImportableBookmarkUrl(rawUrl)) {
      this.unsafe += 1;
      return true;
    }

    const title = sanitizeText(rawTitle, MAX_BOOKMARK_TITLE_LENGTH);
    this.bookmarks.push({
      title: titleOrHost(title, rawUrl),
      url: rawUrl,
      folderPath
    });
    return true;
  }

  public finish(): BookmarkParseResult {
    if (this.unsafe > 0) this.warnings.add("unsafe-url-skipped", this.unsafe);
    if (this.oversized > 0) this.warnings.add("oversized-entry-skipped", this.oversized);
    if (this.malformed > 0) this.warnings.add("malformed-entries-skipped", this.malformed);
    if (this.bookmarks.length === 0) this.warnings.add("no-bookmarks-found");

    return {
      bookmarks: this.bookmarks,
      folderCount: this.folders,
      warnings: this.warnings.list()
    };
  }
}

/* ------------------------------------------------------------------------- */
/* Chromium bookmark JSON                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The Chromium roots, in the order a user reads them.
 *
 * Only these three are walked. A file carrying additional roots — a fork's own,
 * or something an editor added — contributes nothing, because the set of things
 * OpenStrawberry will import is a list it holds, not a list the file supplies.
 */
const CHROMIUM_ROOTS: readonly string[] = ["bookmark_bar", "other", "synced"];

/** Names used when a root does not carry a readable one of its own. */
const ROOT_LABELS: Readonly<Record<string, string>> = {
  bookmark_bar: "Bookmarks bar",
  other: "Other bookmarks",
  synced: "Mobile bookmarks"
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/**
 * Walks one Chromium bookmark node.
 *
 * Depth is carried rather than inferred so the limit is enforced on the way
 * down: a file nested past the bound stops contributing at that point instead of
 * growing the call stack until the process dies.
 */
function walkChromiumNode(
  node: unknown,
  folderPath: readonly string[],
  depth: number,
  collector: BookmarkCollector
): void {
  if (collector.stopHere()) return;

  if (!isPlainRecord(node)) {
    collector.malformedEntry();
    return;
  }

  const type = readString(node, "type");

  if (type === "url") {
    collector.add(readString(node, "name"), readString(node, "url"), folderPath);
    return;
  }

  if (type !== "folder") {
    collector.malformedEntry();
    return;
  }

  const children = node["children"];
  if (!Array.isArray(children)) {
    // A folder with no readable children is empty, not broken.
    return;
  }

  if (depth >= MAX_BOOKMARK_DEPTH) {
    collector.warnings.add("depth-limit-reached");
    return;
  }

  const name = sanitizeText(readString(node, "name"), MAX_FOLDER_NAME_LENGTH);
  const nextPath = name.length > 0 ? [...folderPath, name] : folderPath;
  if (name.length > 0) collector.countFolder();

  for (const child of children) {
    if (collector.stopHere()) return;
    walkChromiumNode(child, nextPath, depth + 1, collector);
  }
}

/**
 * Reads a Chromium `Bookmarks` file.
 *
 * The file is JSON, and a corrupt one is an ordinary user-facing state — a
 * browser killed mid-write leaves exactly this — so it yields an empty result
 * carrying `file-malformed` rather than throwing.
 */
export function parseChromiumBookmarks(text: string): BookmarkParseResult {
  const collector = new BookmarkCollector();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    collector.warnings.add("file-malformed");
    return collector.finish();
  }

  if (!isPlainRecord(parsed) || !isPlainRecord(parsed["roots"])) {
    collector.warnings.add("file-malformed");
    return collector.finish();
  }

  const roots = parsed["roots"];

  for (const key of CHROMIUM_ROOTS) {
    const root = roots[key];
    if (!isPlainRecord(root)) continue;

    const declared = sanitizeText(readString(root, "name"), MAX_FOLDER_NAME_LENGTH);
    const label = declared.length > 0 ? declared : (ROOT_LABELS[key] ?? key);

    const children = root["children"];
    if (!Array.isArray(children)) continue;

    collector.countFolder();
    for (const child of children) {
      if (collector.stopHere()) break;
      walkChromiumNode(child, [label], 1, collector);
    }
  }

  return collector.finish();
}

/* ------------------------------------------------------------------------- */
/* Chromium default search provider name                                      */
/* ------------------------------------------------------------------------- */

/**
 * Reads the *display name* of a profile's configured search engine.
 *
 * Nothing else. The same object holds the search URL template, the suggestion
 * endpoint, the keyword, sync metadata, and in some builds a provider-specific
 * identifier — none of which OpenStrawberry has any business copying, and none
 * of which this function can return, because its return type is a name.
 *
 * Returns null when the preference is absent or unreadable, which is the normal
 * state for a profile that has never changed its search engine.
 */
export function parseChromiumSearchName(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    return null;
  }

  if (!isPlainRecord(parsed)) return null;

  // The current layout.
  const data = parsed["default_search_provider_data"];
  if (isPlainRecord(data)) {
    const templateUrlData = data["template_url_data"];
    if (isPlainRecord(templateUrlData)) {
      const shortName = sanitizeText(readString(templateUrlData, "short_name"), MAX_SEARCH_NAME_LENGTH);
      if (shortName.length > 0) return shortName;
    }
  }

  // The layout older profiles still carry.
  const legacy = parsed["default_search_provider"];
  if (isPlainRecord(legacy)) {
    const name = sanitizeText(readString(legacy, "name"), MAX_SEARCH_NAME_LENGTH);
    if (name.length > 0) return name;
  }

  return null;
}

/* ------------------------------------------------------------------------- */
/* Netscape HTML bookmark exports                                             */
/* ------------------------------------------------------------------------- */

/**
 * The named entities an exported bookmark file actually contains.
 *
 * Deliberately a small closed table rather than a general HTML entity decoder.
 * Bookmark exporters emit this handful, and a decoder that resolves everything
 * is a larger attack surface for no benefit.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, body: string) => {
    const token = body.toLowerCase();

    if (token.startsWith("#")) {
      const isHex = token.startsWith("#x");
      const digits = token.slice(isHex ? 2 : 1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      // Anything outside the Basic Multilingual Plane, and anything that is not
      // a number, is left as written rather than guessed at.
      if (!Number.isFinite(code) || code <= 0 || code > 0xffff) return match;
      return String.fromCharCode(code);
    }

    return NAMED_ENTITIES[token] ?? match;
  });
}

/** Removes any markup nested inside a title before the text is kept. */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/gu, "");
}

const HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu;

function readHref(attributes: string): string {
  const match = HREF_PATTERN.exec(attributes);
  if (match === null) return "";
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/**
 * Reads the text of an element the scanner has just opened.
 *
 * Returns the decoded text and the index just past the closing tag, so the
 * caller can resume scanning after the element rather than re-entering it.
 */
function readElementText(
  source: string,
  from: number,
  closing: string
): { readonly text: string; readonly next: number } {
  const end = source.toLowerCase().indexOf(closing, from);
  if (end === -1) {
    // An unterminated element takes the rest of the line, which is what an
    // exporter that crashed mid-write leaves behind.
    const lineEnd = source.indexOf("\n", from);
    const stop = lineEnd === -1 ? source.length : lineEnd;
    return { text: decodeEntities(stripTags(source.slice(from, stop))), next: stop };
  }

  return {
    text: decodeEntities(stripTags(source.slice(from, end))),
    next: end + closing.length
  };
}

const TOKEN_PATTERN = /<(\/?)(dl|h3|a)(\s[^>]*)?>/giu;

/**
 * Reads a Netscape-format bookmark file, the export Firefox and Safari produce.
 *
 * This is a tag scanner, not an HTML parser. It recognises exactly four tags and
 * ignores everything else, so no scripting, no styling, no embedded content, and
 * no external reference in the file has any effect: the only things that leave
 * this function are folder names, titles, and http(s) addresses.
 *
 * The structure it relies on is the format's own: a `DL` list per folder, an
 * `H3` naming the folder that the following `DL` belongs to, and an `A` per
 * bookmark. Malformed nesting degrades to a flatter result rather than a throw.
 */
export function parseHtmlBookmarks(text: string): BookmarkParseResult {
  const collector = new BookmarkCollector();

  // A file that never opens a list is not a bookmark export.
  if (!/<\s*dl\b/iu.test(text) && !/<\s*a\b[^>]*\bhref\b/iu.test(text)) {
    collector.warnings.add("file-malformed");
    return collector.finish();
  }

  /** Names of the folders currently open. Null marks a list with no heading. */
  const stack: (string | null)[] = [];
  let pendingFolder: string | null = null;
  let depthLimitHit = false;
  let tokens = 0;

  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(text);

  while (match !== null) {
    if (++tokens > MAX_HTML_TOKENS) {
      collector.warnings.add("bookmarks-truncated");
      break;
    }
    if (collector.stopHere()) break;

    const isClosing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const attributes = match[3] ?? "";
    const after = match.index + match[0].length;

    if (tag === "dl") {
      if (isClosing) {
        stack.pop();
      } else {
        // The heading immediately before a list names it; a list with none is
        // the document root or a malformed fragment, and stays anonymous.
        stack.push(pendingFolder);
        if (pendingFolder !== null) collector.countFolder();
        pendingFolder = null;
      }
      match = TOKEN_PATTERN.exec(text);
      continue;
    }

    if (tag === "h3") {
      if (isClosing) {
        match = TOKEN_PATTERN.exec(text);
        continue;
      }
      const heading = readElementText(text, after, "</h3>");
      pendingFolder = sanitizeText(heading.text, MAX_FOLDER_NAME_LENGTH);
      if (pendingFolder.length === 0) pendingFolder = null;
      TOKEN_PATTERN.lastIndex = heading.next;
      match = TOKEN_PATTERN.exec(text);
      continue;
    }

    // tag === "a"
    if (isClosing) {
      match = TOKEN_PATTERN.exec(text);
      continue;
    }

    const anchor = readElementText(text, after, "</a>");
    TOKEN_PATTERN.lastIndex = anchor.next;

    const folderPath = stack.filter((name): name is string => name !== null);

    if (folderPath.length > MAX_BOOKMARK_DEPTH) {
      if (!depthLimitHit) {
        depthLimitHit = true;
        collector.warnings.add("depth-limit-reached");
      }
      match = TOKEN_PATTERN.exec(text);
      continue;
    }

    const href = readHref(attributes);
    if (href.length === 0) collector.malformedEntry();
    else collector.add(anchor.text, href, folderPath);

    match = TOKEN_PATTERN.exec(text);
  }

  return collector.finish();
}
