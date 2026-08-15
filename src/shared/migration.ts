export type BrowserId = "chrome" | "edge" | "brave" | "firefox" | "safari";
export type BrowserMigrationCandidate = { id: BrowserId; label: string; detected: boolean; profileCount: number; bookmarkImport: "supported" | "export-file-required" | "not-available"; settingsImport: "supported" | "export-file-required" | "not-available" };
export type MigratedBookmark = { title: string; url: string; folder: string[] };
export type MigrationImportResult = { browser: BrowserId; bookmarksImported: number; defaultSearchProvider?: string; note: string };
export type OnboardingState = { completed: boolean; importedBrowser?: BrowserId; importedAt?: number };

export function extractChromiumBookmarks(serialized: string): MigratedBookmark[] {
  const parsed = JSON.parse(serialized) as { roots?: Record<string, unknown> };
  const bookmarks: MigratedBookmark[] = [];
  const walk = (node: unknown, folders: string[]): void => {
    if (!node || typeof node !== "object") return;
    const value = node as { name?: unknown; url?: unknown; children?: unknown };
    const title = typeof value.name === "string" ? value.name.trim() : "";
    const url = typeof value.url === "string" ? value.url.trim() : "";
    if (/^https?:\/\//i.test(url)) bookmarks.push({ title: title || url, url, folder: folders });
    if (Array.isArray(value.children)) value.children.forEach((child) => walk(child, title ? [...folders, title] : folders));
  };
  Object.values(parsed.roots ?? {}).forEach((root) => walk(root, []));
  return bookmarks.slice(0, 10_000);
}

export function extractChromiumDefaultSearch(serialized: string): string | undefined {
  try {
    const parsed = JSON.parse(serialized) as { default_search_provider_data?: { template_url_data?: { short_name?: unknown } } };
    const shortName = parsed.default_search_provider_data?.template_url_data?.short_name;
    return typeof shortName === "string" && shortName.trim() ? shortName.trim().slice(0, 120) : undefined;
  } catch { return undefined; }
}
