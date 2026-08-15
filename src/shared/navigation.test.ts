import { describe, expect, it } from "vitest";
import { isBrowserUrlAllowed, normalizeAddress, normalizeBrowserUrl } from "./navigation.js";

describe("normalizeAddress", () => {
  it("preserves explicit web URLs", () => {
    expect(normalizeAddress("https://example.com/path")).toBe("https://example.com/path");
  });

  it("adds HTTPS to a hostname", () => {
    expect(normalizeAddress("openstrawberry.dev")).toBe("https://openstrawberry.dev");
  });

  it("sends plain-language input to a search query", () => {
    expect(normalizeAddress("desktop browser agents")).toBe("https://www.google.com/search?q=desktop%20browser%20agents");
  });
});

describe("isBrowserUrlAllowed", () => {
  it("allows HTTP and HTTPS navigation", () => {
    expect(isBrowserUrlAllowed("http://example.com")).toBe(true);
    expect(isBrowserUrlAllowed("https://example.com")).toBe(true);
  });

  it("rejects unsupported schemes", () => {
    expect(isBrowserUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isBrowserUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(isBrowserUrlAllowed("mailto:hello@example.com")).toBe(false);
  });
});

describe("normalizeBrowserUrl", () => {
  it("rejects unsafe, malformed, and oversized values before a BrowserView load", () => {
    expect(() => normalizeBrowserUrl("file:///etc/passwd")).toThrow("Only HTTP");
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow("Only HTTP");
    expect(() => normalizeBrowserUrl({ url: "https://example.com" })).toThrow("text");
    expect(() => normalizeBrowserUrl("x".repeat(8_193))).toThrow("too long");
  });
});
