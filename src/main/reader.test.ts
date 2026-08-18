import { describe, expect, it } from "vitest";
import { extractReaderDocument, type ReaderContentsPort } from "./reader.js";

function contentsReturning(
  result: unknown,
  url = "https://news.example.com/article"
): ReaderContentsPort {
  return {
    executeJavaScript: async () => result,
    getURL: () => url
  };
}

const ARTICLE = {
  title: "A Considered Headline",
  byline: "By Someone",
  site: "news.example.com",
  blocks: [
    { kind: "heading", text: "A Considered Headline" },
    { kind: "paragraph", text: "The opening paragraph of the article body." }
  ]
};

describe("extractReaderDocument", () => {
  it("returns a document for an article", async () => {
    const state = await extractReaderDocument(contentsReturning(ARTICLE));

    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.document.title).toBe("A Considered Headline");
    expect(state.document.blocks).toHaveLength(2);
  });

  it("reports a page with no article as unavailable rather than failing", async () => {
    for (const result of [null, undefined, {}, { blocks: [] }, 42, "text"]) {
      const state = await extractReaderDocument(contentsReturning(result));
      expect(state.status).toBe("unavailable");
    }
  });

  it("distinguishes a page that threw from one that is not an article", async () => {
    const throwing: ReaderContentsPort = {
      executeJavaScript: async () => {
        throw new Error("page navigated mid-extraction");
      },
      getURL: () => "https://example.com/"
    };

    const state = await extractReaderDocument(throwing);
    expect(state).toEqual({ status: "unavailable", reason: "extraction-failed" });
  });

  it("never throws, whatever the page hands back", async () => {
    // The extraction script runs inside a page that can redefine anything, so
    // its output is hostile input rather than this module's own result.
    const hostile = [
      { blocks: [{ kind: "paragraph", get text() { throw new Error("boom"); } }] },
      { blocks: [null, undefined, 1, "x"] },
      { title: { toString: () => "x" }, blocks: [{ kind: "paragraph", text: "prose here now" }] }
    ];

    for (const result of hostile) {
      await expect(extractReaderDocument(contentsReturning(result))).resolves.toBeDefined();
    }
  });

  it("labels the document with the real host, not the one the page claimed", async () => {
    const state = await extractReaderDocument(
      contentsReturning({ ...ARTICLE, site: "" }, "https://actual-host.example/x")
    );

    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.document.site).toBe("actual-host.example");
  });

  it("tolerates a page whose URL will not parse", async () => {
    const state = await extractReaderDocument(
      contentsReturning({ ...ARTICLE, site: "" }, "not a url")
    );
    expect(state.status).toBe("ready");
  });
});
