import { describe, expect, it } from "vitest";
import {
  bookmarkLabel,
  emptyBookmarkPage,
  matchesBookmarkQuery,
  MAX_BOOKMARK_LABEL_LENGTH,
  MAX_BOOKMARK_QUERY_LENGTH,
  parseBookmarkQueryPayload,
  type BookmarkEntry
} from "./bookmarks.js";

const RTL_OVERRIDE = "\u202E";

function entry(overrides: Partial<BookmarkEntry> = {}): BookmarkEntry {
  return {
    title: "Rust Book",
    url: "https://doc.rust-lang.org/book/",
    folder: "Programming / Rust",
    ...overrides
  };
}

describe("bookmarkLabel", () => {
  it("collapses whitespace and bounds length", () => {
    expect(bookmarkLabel("  a   b ")).toBe("a b");
    expect(bookmarkLabel("t".repeat(500)).length).toBeLessThanOrEqual(MAX_BOOKMARK_LABEL_LENGTH);
  });

  it("re-cleans a label that was edited on disk", () => {
    // Cleaned at import too, but the file could have changed since.
    expect(bookmarkLabel(`Safe${RTL_OVERRIDE}title`)).toBe("Safetitle");
    expect(bookmarkLabel("a\u0000b\u001Fc")).toBe("abc");
  });

  it("returns empty for a non-string", () => {
    for (const value of [null, undefined, 42, {}, []]) expect(bookmarkLabel(value)).toBe("");
  });
});

describe("matchesBookmarkQuery", () => {
  it("matches an empty query, so the panel is browsable before typing", () => {
    expect(matchesBookmarkQuery(entry(), "")).toBe(true);
    expect(matchesBookmarkQuery(entry(), "   ")).toBe(true);
  });

  it("matches the title, the address, and the folder", () => {
    expect(matchesBookmarkQuery(entry(), "rust book")).toBe(true);
    expect(matchesBookmarkQuery(entry(), "doc.rust-lang")).toBe(true);
    expect(matchesBookmarkQuery(entry(), "programming")).toBe(true);
  });

  it("ignores case", () => {
    expect(matchesBookmarkQuery(entry(), "RUST")).toBe(true);
  });

  it("is false when nothing contains it", () => {
    expect(matchesBookmarkQuery(entry(), "haskell")).toBe(false);
  });
});

describe("parseBookmarkQueryPayload", () => {
  it("treats an absent query as the browsable default", () => {
    expect(parseBookmarkQueryPayload({})).toEqual({ query: "" });
    expect(parseBookmarkQueryPayload({ query: null })).toEqual({ query: "" });
  });

  it("accepts a real query", () => {
    expect(parseBookmarkQueryPayload({ query: "rust" })).toEqual({ query: "rust" });
  });

  it("refuses a query past the bound rather than truncating silently", () => {
    expect(() =>
      parseBookmarkQueryPayload({ query: "a".repeat(MAX_BOOKMARK_QUERY_LENGTH + 1) })
    ).toThrow();
  });

  it("refuses anything that is not a plain object with a string", () => {
    for (const hostile of [null, [], "rust", { query: 42 }, { query: [] }]) {
      expect(() => parseBookmarkQueryPayload(hostile)).toThrow();
    }
  });
});

describe("emptyBookmarkPage", () => {
  it("starts with nothing and claims no total", () => {
    expect(emptyBookmarkPage()).toEqual({ entries: [], total: 0, truncated: false });
  });
});
