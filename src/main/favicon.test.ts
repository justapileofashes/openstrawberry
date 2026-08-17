import { describe, expect, it } from "vitest";
import {
  conventionalFaviconUrl,
  isAllowedFaviconMime,
  MAX_FAVICON_BYTES,
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
