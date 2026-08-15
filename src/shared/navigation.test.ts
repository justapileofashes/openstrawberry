import { describe, expect, it } from "vitest";
import { isBrowserUrlAllowed, normalizeAddress } from "./navigation.js";

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
