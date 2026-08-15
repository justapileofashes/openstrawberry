import { describe, expect, it } from "vitest";
import { extractChromiumBookmarks, extractChromiumDefaultSearch } from "./migration.js";

describe("Chromium migration parsing", () => {
  it("imports only web bookmarks and preserves a bounded folder trail", () => {
    const input = JSON.stringify({ roots: { bookmark_bar: { name: "Bookmarks bar", children: [{ name: "Research", children: [{ name: "OpenStrawberry", url: "https://github.com/justapileofashes/openstrawberry" }, { name: "Local", url: "file:///private/path" }] }] } } });
    expect(extractChromiumBookmarks(input)).toEqual([{ title: "OpenStrawberry", url: "https://github.com/justapileofashes/openstrawberry", folder: ["Bookmarks bar", "Research"] }]);
  });

  it("reads only the display name of a Chromium default search provider", () => {
    expect(extractChromiumDefaultSearch(JSON.stringify({ default_search_provider_data: { template_url_data: { short_name: "DuckDuckGo" } } }))).toBe("DuckDuckGo");
    expect(extractChromiumDefaultSearch("not json")).toBeUndefined();
  });
});
