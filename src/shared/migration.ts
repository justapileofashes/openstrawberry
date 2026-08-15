export type BrowserId = "chrome" | "edge" | "brave" | "firefox" | "safari";
export type BrowserMigrationCandidate = { id: BrowserId; label: string; detected: boolean; profileCount: number; bookmarkImport: "supported" | "export-file-required" | "not-available"; settingsImport: "supported" | "export-file-required" | "not-available" };
export type MigratedBookmark = { title: string; url: string; folder: string[] };
export type MigrationImportResult = { browser: BrowserId; bookmarksImported: number; defaultSearchProvider?: string; note: string };
export type BookmarkExportPreview = { importId: string; browser: BrowserId; fileName: string; bookmarksFound: number; note: string };
export type BookmarkExportImportResult = { browser: BrowserId; bookmarksImported: number; note: string };
export type PasswordExportPreview = { importId: string; browser: BrowserId; fileName: string; entriesFound: number; distinctSites: number; note: string };
export type PasswordExportImportResult = { browser: BrowserId; entriesImported: number; distinctSites: number; note: string };
export type OnboardingState = { completed: boolean; importedBrowser?: BrowserId; importedAt?: number };
const MAX_BOOKMARKS = 10_000;
const MAX_DEPTH = 32;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;

export function extractChromiumBookmarks(serialized: string): MigratedBookmark[] {
  const parsed = JSON.parse(serialized) as { roots?: Record<string, unknown> };
  const bookmarks: MigratedBookmark[] = [];
  const pending: { node: unknown; folders: string[]; depth: number }[] = Object.values(parsed.roots ?? {}).map((node) => ({ node, folders: [], depth: 0 }));
  while (pending.length && bookmarks.length < MAX_BOOKMARKS) {
    const { node, folders, depth } = pending.pop()!;
    if (!node || typeof node !== "object" || depth > MAX_DEPTH) continue;
    const value = node as { name?: unknown; url?: unknown; children?: unknown };
    const title = typeof value.name === "string" ? value.name.trim() : "";
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (isSafeBookmarkUrl(url)) bookmarks.push({ title: (title || url).slice(0, MAX_TITLE_LENGTH), url, folder: folders.map((folder) => folder.slice(0, MAX_TITLE_LENGTH)) });
    if (Array.isArray(value.children)) {
      const nextFolders = title ? [...folders, title.slice(0, MAX_TITLE_LENGTH)].slice(-MAX_DEPTH) : folders;
      for (let index = Math.min(value.children.length, MAX_BOOKMARKS) - 1; index >= 0; index -= 1) pending.push({ node: value.children[index], folders: nextFolders, depth: depth + 1 });
    }
  }
  return bookmarks;
}

export function extractHtmlBookmarks(serialized: string): MigratedBookmark[] {
  const bookmarks: MigratedBookmark[] = [];
  const folders: (string | undefined)[] = [];
  let pendingFolder: string | undefined;
  let capture: "folder" | "bookmark" | undefined;
  let capturedText = "";
  let bookmarkUrl = "";
  const tokenPattern = /<(\/?)(h3|a|dl)\b([^>]*)>|([^<]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(serialized)) && bookmarks.length < MAX_BOOKMARKS) {
    const [, closing, tagName, attributes = "", text = ""] = match;
    const tag = tagName?.toLowerCase();
    if (text) { if (capture) capturedText += text; continue; }
    if (tag === "dl") {
      if (closing) folders.pop();
      else { folders.push(pendingFolder); pendingFolder = undefined; }
      continue;
    }
    if (tag === "h3") {
      if (closing) { pendingFolder = normalizeBookmarkText(capturedText); capture = undefined; capturedText = ""; }
      else { capture = "folder"; capturedText = ""; }
      continue;
    }
    if (tag === "a") {
      if (closing) {
        const url = decodeHtmlEntities(bookmarkUrl).trim();
        const title = normalizeBookmarkText(capturedText) || url;
        if (isSafeBookmarkUrl(url)) bookmarks.push({ title: title.slice(0, MAX_TITLE_LENGTH), url, folder: folders.filter((folder): folder is string => Boolean(folder)).slice(-MAX_DEPTH).map((folder) => folder.slice(0, MAX_TITLE_LENGTH)) });
        capture = undefined;
        capturedText = "";
        bookmarkUrl = "";
      } else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
        bookmarkUrl = href?.[1] ?? href?.[2] ?? href?.[3] ?? "";
        capture = "bookmark";
        capturedText = "";
      }
    }
  }
  return bookmarks;
}

export function extractChromiumDefaultSearch(serialized: string): string | undefined {
  try {
    const parsed = JSON.parse(serialized) as { default_search_provider_data?: { template_url_data?: { short_name?: unknown } } };
    const shortName = parsed.default_search_provider_data?.template_url_data?.short_name;
    return typeof shortName === "string" && shortName.trim() ? shortName.trim().slice(0, 120) : undefined;
  } catch { return undefined; }
}

function isSafeBookmarkUrl(value: string): boolean {
  if (!value || value.length > MAX_URL_LENGTH) return false;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}

function normalizeBookmarkText(value: string): string { return decodeHtmlEntities(value.replace(/\s+/g, " ")).trim(); }
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_token, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const codePoint = normalized.startsWith("#x") ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
  });
}
