import { describe, expect, it } from "vitest";
import {
  parseChromiumBookmarks,
  parseChromiumSearchName,
  parseHtmlBookmarks
} from "./bookmark-parsers.js";
import {
  MAX_BOOKMARK_DEPTH,
  MAX_BOOKMARK_RECORDS,
  MAX_BOOKMARK_TITLE_LENGTH,
  type MigrationWarningCode
} from "../shared/migration.js";

function codes(warnings: readonly { readonly code: MigrationWarningCode }[]): string[] {
  return warnings.map((warning) => warning.code);
}

function chromiumFile(children: unknown): string {
  return JSON.stringify({
    version: 1,
    roots: { bookmark_bar: { type: "folder", name: "Bookmarks bar", children } }
  });
}

describe("parseChromiumBookmarks", () => {
  it("reads a nested tree and records the folder path", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([
        { type: "url", name: "Example", url: "https://example.com/" },
        {
          type: "folder",
          name: "Reading",
          children: [{ type: "url", name: "Docs", url: "https://docs.example.com/a" }]
        }
      ])
    );

    expect(result.bookmarks).toEqual([
      { title: "Example", url: "https://example.com/", folderPath: ["Bookmarks bar"] },
      { title: "Docs", url: "https://docs.example.com/a", folderPath: ["Bookmarks bar", "Reading"] }
    ]);
    expect(result.folderCount).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("walks every known root and labels each one", () => {
    const result = parseChromiumBookmarks(
      JSON.stringify({
        roots: {
          bookmark_bar: { type: "folder", name: "Bar", children: [{ type: "url", name: "A", url: "https://a.test/" }] },
          other: { type: "folder", name: "Other", children: [{ type: "url", name: "B", url: "https://b.test/" }] },
          synced: { type: "folder", name: "Mobile", children: [{ type: "url", name: "C", url: "https://c.test/" }] }
        }
      })
    );

    expect(result.bookmarks.map((entry) => entry.folderPath[0])).toEqual(["Bar", "Other", "Mobile"]);
  });

  it("ignores roots the app does not import", () => {
    const result = parseChromiumBookmarks(
      JSON.stringify({
        roots: {
          bookmark_bar: { type: "folder", name: "Bar", children: [] },
          vendor_extras: {
            type: "folder",
            name: "Vendor",
            children: [{ type: "url", name: "X", url: "https://x.test/" }]
          }
        }
      })
    );

    expect(result.bookmarks).toEqual([]);
  });

  it("skips unsafe schemes and counts them", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([
        { type: "url", name: "Bad", url: "javascript:alert(1)" },
        { type: "url", name: "Data", url: "data:text/html,<h1>x</h1>" },
        { type: "url", name: "File", url: "file:///c:/secrets.txt" },
        { type: "url", name: "Creds", url: "https://user:pass@example.com/" },
        { type: "url", name: "Good", url: "https://example.com/" }
      ])
    );

    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0]?.url).toBe("https://example.com/");
    expect(codes(result.warnings)).toContain("unsafe-url-skipped");
    expect(result.warnings.find((w) => w.code === "unsafe-url-skipped")?.count).toBe(4);
  });

  it("skips malformed nodes without abandoning the file", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([
        null,
        42,
        { type: "url", name: "No URL" },
        { type: "mystery", name: "Unknown" },
        { type: "url", name: "Good", url: "https://example.com/" }
      ])
    );

    expect(result.bookmarks).toHaveLength(1);
    expect(codes(result.warnings)).toContain("malformed-entries-skipped");
  });

  it("stops descending past the depth limit", () => {
    let node: unknown = { type: "url", name: "Deep", url: "https://deep.test/" };
    for (let index = 0; index < MAX_BOOKMARK_DEPTH + 4; index += 1) {
      node = { type: "folder", name: `L${index}`, children: [node] };
    }

    const result = parseChromiumBookmarks(chromiumFile([node]));

    expect(result.bookmarks).toHaveLength(0);
    expect(codes(result.warnings)).toContain("depth-limit-reached");
  });

  it("stops at the record limit rather than reading an unbounded file", () => {
    const children = Array.from({ length: MAX_BOOKMARK_RECORDS + 50 }, (_unused, index) => ({
      type: "url",
      name: `Entry ${index}`,
      url: `https://example.com/${index}`
    }));

    const result = parseChromiumBookmarks(chromiumFile(children));

    expect(result.bookmarks).toHaveLength(MAX_BOOKMARK_RECORDS);
    expect(codes(result.warnings)).toContain("bookmarks-truncated");
  });

  it("skips an entry whose address exceeds the bound", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([{ type: "url", name: "Huge", url: `https://example.com/${"a".repeat(8000)}` }])
    );

    expect(result.bookmarks).toHaveLength(0);
    expect(codes(result.warnings)).toContain("oversized-entry-skipped");
  });

  it("trims an over-long title rather than dropping the bookmark", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([{ type: "url", name: "T".repeat(900), url: "https://example.com/" }])
    );

    expect(result.bookmarks[0]?.title.length).toBe(MAX_BOOKMARK_TITLE_LENGTH);
  });

  it("strips control characters and bidirectional overrides from titles", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([{ type: "url", name: "Pay\u202Emoc.live\u0007 now", url: "https://example.com/" }])
    );

    const title = result.bookmarks[0]?.title ?? "";
    expect(title).not.toMatch(/[\u0000-\u001F\u202A-\u202E]/u);
    expect(title).toBe("Pay moc.live now");
  });

  it("falls back to the host when a bookmark has no title", () => {
    const result = parseChromiumBookmarks(
      chromiumFile([{ type: "url", name: "", url: "https://example.com/deep/page" }])
    );

    expect(result.bookmarks[0]?.title).toBe("example.com");
  });

  it("reports a corrupt file as a warning rather than throwing", () => {
    for (const text of ["", "{", "not json", "[]", '{"roots":5}']) {
      const result = parseChromiumBookmarks(text);
      expect(result.bookmarks).toEqual([]);
      expect(codes(result.warnings)).toContain("file-malformed");
    }
  });

  it("tolerates a byte-order mark", () => {
    const result = parseChromiumBookmarks(
      `\uFEFF${chromiumFile([{ type: "url", name: "A", url: "https://a.test/" }])}`
    );
    expect(result.bookmarks).toHaveLength(1);
  });

  it("reports an empty source rather than a fault", () => {
    const result = parseChromiumBookmarks(chromiumFile([]));
    expect(codes(result.warnings)).toContain("no-bookmarks-found");
  });
});

describe("parseChromiumSearchName", () => {
  it("reads the current display name only", () => {
    const text = JSON.stringify({
      default_search_provider_data: {
        template_url_data: {
          short_name: "DuckDuckGo",
          keyword: "duckduckgo.com",
          url: "https://duckduckgo.com/?q={searchTerms}&key=SECRET",
          suggestions_url: "https://duckduckgo.com/ac/?q={searchTerms}",
          sync_guid: "abc-123"
        }
      },
      account_info: [{ email: "person@example.com" }]
    });

    expect(parseChromiumSearchName(text)).toBe("DuckDuckGo");
  });

  it("reads the legacy display name", () => {
    expect(
      parseChromiumSearchName(JSON.stringify({ default_search_provider: { name: "Startpage" } }))
    ).toBe("Startpage");
  });

  it("returns null when no provider name is configured", () => {
    for (const text of ["", "{}", "broken", JSON.stringify({ default_search_provider: {} })]) {
      expect(parseChromiumSearchName(text)).toBeNull();
    }
  });

  it("bounds and cleans an over-long or hostile name", () => {
    const name = parseChromiumSearchName(
      JSON.stringify({ default_search_provider: { name: `${"x".repeat(400)}\n\u202Eevil` } })
    );

    expect(name?.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/[\u0000-\u001F\u202A-\u202E]/u);
  });
});

describe("parseHtmlBookmarks", () => {
  const exported = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
    <DT><A HREF="https://example.com/" ADD_DATE="1700000000">Example &amp; Co</A>
    <DT><H3 ADD_DATE="1700000000">Work</H3>
    <DL><p>
        <DT><A HREF="https://work.example.com/a">Task &#65;</A>
        <DT><H3>Deep</H3>
        <DL><p>
            <DT><A HREF="https://work.example.com/b">Nested</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://after.example.com/">After</A>
</DL><p>`;

  it("reads anchors and reconstructs the folder path", () => {
    const result = parseHtmlBookmarks(exported);

    expect(result.bookmarks).toEqual([
      { title: "Example & Co", url: "https://example.com/", folderPath: [] },
      { title: "Task A", url: "https://work.example.com/a", folderPath: ["Work"] },
      { title: "Nested", url: "https://work.example.com/b", folderPath: ["Work", "Deep"] },
      { title: "After", url: "https://after.example.com/", folderPath: [] }
    ]);
    expect(result.folderCount).toBe(2);
  });

  it("rejects unsafe schemes", () => {
    const result = parseHtmlBookmarks(`<DL><p>
      <DT><A HREF="javascript:alert(1)">Bad</A>
      <DT><A HREF="data:text/html,x">Data</A>
      <DT><A HREF="file:///etc/passwd">File</A>
      <DT><A HREF="chrome://settings">Internal</A>
      <DT><A HREF="https://ok.test/">Fine</A>
    </DL>`);

    expect(result.bookmarks.map((entry) => entry.url)).toEqual(["https://ok.test/"]);
    expect(result.warnings.find((w) => w.code === "unsafe-url-skipped")?.count).toBe(4);
  });

  it("ignores scripting and markup that is not part of the format", () => {
    const result = parseHtmlBookmarks(`<DL><p>
      <script>window.stolen = 1;</script>
      <img src="https://tracker.test/pixel.gif">
      <DT><A HREF="https://ok.test/" ONCLICK="steal()">Ti<b>tl</b>e</A>
    </DL>`);

    expect(result.bookmarks).toEqual([
      { title: "Title", url: "https://ok.test/", folderPath: [] }
    ]);
  });

  it("accepts single-quoted and unquoted href attributes", () => {
    const result = parseHtmlBookmarks(`<DL><p>
      <DT><A HREF='https://single.test/'>Single</A>
      <DT><A HREF=https://bare.test/ ADD_DATE="1">Bare</A>
    </DL>`);

    expect(result.bookmarks.map((entry) => entry.url)).toEqual([
      "https://single.test/",
      "https://bare.test/"
    ]);
  });

  it("counts an anchor with no address as malformed", () => {
    const result = parseHtmlBookmarks(`<DL><p><DT><A NAME="anchor">No link</A></DL>`);

    expect(result.bookmarks).toEqual([]);
    expect(codes(result.warnings)).toContain("malformed-entries-skipped");
  });

  it("survives unbalanced lists without throwing", () => {
    const result = parseHtmlBookmarks(`<DL><p>
      <DT><H3>Open</H3>
      <DL><p>
        <DT><A HREF="https://a.test/">A</A>
      </DL></DL></DL><p>
      <DT><A HREF="https://b.test/">B</A>`);

    expect(result.bookmarks.map((entry) => entry.url)).toEqual([
      "https://a.test/",
      "https://b.test/"
    ]);
  });

  it("survives an unterminated anchor", () => {
    const result = parseHtmlBookmarks(`<DL><p><DT><A HREF="https://a.test/">Truncated`);
    expect(result.bookmarks[0]?.title).toBe("Truncated");
  });

  it("rejects a file that is not a bookmark export", () => {
    const result = parseHtmlBookmarks("<html><body><p>Just a page</p></body></html>");
    expect(result.bookmarks).toEqual([]);
    expect(codes(result.warnings)).toContain("file-malformed");
  });

  it("stops at the record limit", () => {
    const anchors = Array.from(
      { length: MAX_BOOKMARK_RECORDS + 20 },
      (_unused, index) => `<DT><A HREF="https://example.com/${index}">E${index}</A>`
    ).join("\n");

    const result = parseHtmlBookmarks(`<DL><p>${anchors}</DL>`);

    expect(result.bookmarks).toHaveLength(MAX_BOOKMARK_RECORDS);
    expect(codes(result.warnings)).toContain("bookmarks-truncated");
  });

  it("stops recording below the depth limit", () => {
    const open = "<DT><H3>F</H3><DL><p>".repeat(MAX_BOOKMARK_DEPTH + 3);
    const result = parseHtmlBookmarks(
      `<DL><p>${open}<DT><A HREF="https://deep.test/">Deep</A>`
    );

    expect(result.bookmarks).toHaveLength(0);
    expect(codes(result.warnings)).toContain("depth-limit-reached");
  });

  it("decodes only the entities an exporter emits", () => {
    const result = parseHtmlBookmarks(
      `<DL><p><DT><A HREF="https://a.test/">&lt;b&gt; &amp; &quot;q&quot; &#39;s&#39; &unknown;</A></DL>`
    );

    expect(result.bookmarks[0]?.title).toBe(`<b> & "q" 's' &unknown;`);
  });
});
