export type BrowserId = "chrome" | "edge" | "brave" | "firefox" | "safari";
export type BrowserMigrationCandidate = { id: BrowserId; label: string; detected: boolean; profileCount: number; bookmarkImport: "supported" | "export-file-required" | "not-available"; settingsImport: "supported" | "export-file-required" | "not-available" };
export type MigratedBookmark = { title: string; url: string; folder: string[] };
export type MigrationImportResult = { browser: BrowserId; bookmarksImported: number; defaultSearchProvider?: string; note: string };
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
