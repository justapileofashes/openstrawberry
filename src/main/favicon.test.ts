import { describe, expect, it } from "vitest";
import {
  conventionalFaviconUrl,
  isAllowedFaviconMime,
  MAX_FAVICON_BYTES,
  readBoundedStream,
  toDataUrl
} from "./favicon.js";

describe("isAllowedFaviconMime", () => {
  it("accepts real image types, including with a charset parameter", () => {
    for (const value of [
      "image/png",
      "image/x-icon",
      "image/vnd.microsoft.icon",
      "IMAGE/PNG",
      "image/svg+xml; charset=utf-8",
      " image/webp "
    ]) {
      expect(isAllowedFaviconMime(value)).toBe(true);
    }
  });

  it("refuses anything that is not an allowlisted image", () => {
    for (const value of [
      null,
      "",
      "text/html",
      "application/json",
      "text/html; charset=utf-8",
      "application/octet-stream",
      "image/tiff"
    ]) {
      expect(isAllowedFaviconMime(value)).toBe(false);
    }
  });

  it("refuses an HTML error page served where an icon was expected", () => {
    // A site returning its 404 page for /favicon.ico must not be inlined.
    expect(isAllowedFaviconMime("text/html")).toBe(false);
  });
});

describe("conventionalFaviconUrl", () => {
  it("derives the well-known path from an HTTPS origin", () => {
    expect(conventionalFaviconUrl("https://example.com/some/page?q=1")).toBe(
      "https://example.com/favicon.ico"
    );
    expect(conventionalFaviconUrl("https://sub.example.co.uk:8443/")).toBe(
      "https://sub.example.co.uk:8443/favicon.ico"
    );
  });

  it("refuses non-HTTPS and unparseable pages", () => {
    for (const value of ["http://example.com/", "about:blank", "file:///c:/x", "nonsense", ""]) {
      expect(conventionalFaviconUrl(value)).toBeNull();
    }
  });
});

describe("toDataUrl", () => {
  it("produces a base64 data URL carrying the declared mime", () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    expect(toDataUrl("image/png", bytes)).toBe("data:image/png;base64,AAECAw==");
  });

  it("strips parameters from the mime so the URL stays well formed", () => {
    expect(toDataUrl("image/svg+xml; charset=utf-8", new Uint8Array([65]))).toBe(
      "data:image/svg+xml;base64,QQ=="
    );
  });
});

describe("size bound", () => {
  it("keeps the favicon cap small enough to inline safely", () => {
    expect(MAX_FAVICON_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("readBoundedStream", () => {
  /** A body that yields the given chunks, recording whether it was cancelled. */
  function streamOf(chunks: readonly Uint8Array[]): {
    readonly body: ReadableStream<Uint8Array>;
    readonly wasCancelled: () => boolean;
  } {
    let cancelled = false;
    let index = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      }
    });

    return { body, wasCancelled: () => cancelled };
  }

  it("joins the chunks of a body that fits", async () => {
    const { body } = streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]);
    await expect(readBoundedStream(body, 16)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null for a missing body", async () => {
    await expect(readBoundedStream(null, 16)).resolves.toBeNull();
  });

  it("returns an empty array for an empty body, which the caller treats as absent", async () => {
    const { body } = streamOf([]);
    await expect(readBoundedStream(body, 16)).resolves.toEqual(new Uint8Array(0));
  });

  it("gives up once the running total passes the cap", async () => {
    const { body } = streamOf([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)]);
    await expect(readBoundedStream(body, 8)).resolves.toBeNull();
  });

  it("stops reading an endless body rather than buffering it", async () => {
    // The case `content-length` cannot catch: a chunked response that never
    // ends. Reaching the assertion at all is the proof — an unbounded read
    // would not return.
    let served = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += 1;
        controller.enqueue(new Uint8Array(1024));
      }
    });

    await expect(readBoundedStream(body, 4096)).resolves.toBeNull();
    expect(served).toBeLessThan(16);
  });

  it("cancels the body it abandoned, so the connection is not left open", async () => {
    const { body, wasCancelled } = streamOf([new Uint8Array(32)]);
    await expect(readBoundedStream(body, 8)).resolves.toBeNull();
    expect(wasCancelled()).toBe(true);
  });
});
