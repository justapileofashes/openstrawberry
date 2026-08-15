import { describe, expect, it } from "vitest";
import { extractChromiumBookmarks, extractChromiumDefaultSearch, extractHtmlBookmarks } from "./migration.js";

describe("Chromium migration parsing", () => {
  it("imports only web bookmarks and preserves a bounded folder trail", () => {
    const input = JSON.stringify({ roots: { bookmark_bar: { name: "Bookmarks bar", children: [{ name: "Research", children: [{ name: "OpenStrawberry", url: "https://github.com/justapileofashes/openstrawberry" }, { name: "Local", url: "file:///private/path" }] }] } } });
    expect(extractChromiumBookmarks(input)).toEqual([{ title: "OpenStrawberry", url: "https://github.com/justapileofashes/openstrawberry", folder: ["Bookmarks bar", "Research"] }]);
  });

  it("reads only the display name of a Chromium default search provider", () => {
    expect(extractChromiumDefaultSearch(JSON.stringify({ default_search_provider_data: { template_url_data: { short_name: "DuckDuckGo" } } }))).toBe("DuckDuckGo");
    expect(extractChromiumDefaultSearch("not json")).toBeUndefined();
  });

  it("bounds deep traversal and excludes malformed or oversized bookmark URLs", () => {
    let root: Record<string, unknown> = { name: "Folder", children: [] };
    const top = root;
    for (let index = 0; index < 40; index += 1) { const child: Record<string, unknown> = { name: `Folder ${index}`, children: [] }; (root.children as unknown[]).push(child); root = child; }
    (root.children as unknown[]).push({ name: "Bad", url: "https://" }, { name: "Oversized", url: `https://example.com/${"x".repeat(2_050)}` });
    expect(extractChromiumBookmarks(JSON.stringify({ roots: { bar: top } }))).toEqual([]);
  });

  it("imports a manual Firefox or Safari-style HTML export while retaining folders and excluding unsafe links", () => {
    const html = "<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><H3>Reading &amp; Research</H3><DL><p><DT><A HREF=\"https://example.com/article\">An &amp; article</A><DT><A HREF=\"file:///private/path\">Local file</A></DL><p></DL><p>";
    expect(extractHtmlBookmarks(html)).toEqual([{ title: "An & article", url: "https://example.com/article", folder: ["Reading & Research"] }]);
  });
});
