import { describe, expect, it } from "vitest";
import { BLANK_PAGE } from "./desktop-shell.js";
import {
  buildSearchUrl,
  displayHostname,
  isAllowedUrl,
  isSafeFaviconUrl,
  MAX_ADDRESS_LENGTH,
  normalizeAddressInput
} from "./navigation.js";

describe("isAllowedUrl", () => {
  it("allows HTTP and HTTPS", () => {
    expect(isAllowedUrl("https://example.com/")).toBe(true);
    expect(isAllowedUrl("http://localhost:3000/")).toBe(true);
  });

  it("allows exactly the neutral internal page", () => {
    expect(isAllowedUrl(BLANK_PAGE)).toBe(true);
  });

  it("refuses anything that merely resembles the internal page", () => {
    for (const value of ["about:blank#x", "about:blank?a=1", "about:srcdoc", "about:config", "ABOUT:BLANK"]) {
      expect(isAllowedUrl(value)).toBe(false);
    }
  });

  it("refuses unsafe schemes", () => {
    for (const value of [
      "file:///C:/Windows/System32/",
      "file:///etc/passwd",
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/uuid",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "ws://example.com",
      "ftp://example.com"
    ]) {
      expect(isAllowedUrl(value)).toBe(false);
    }
  });

  it("refuses URLs carrying embedded credentials", () => {
    expect(isAllowedUrl("https://user:pass@example.com/")).toBe(false);
    expect(isAllowedUrl("https://user@example.com/")).toBe(false);
  });

  it("refuses hostless and unparseable URLs", () => {
    expect(isAllowedUrl("https://")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
  });
});

describe("normalizeAddressInput", () => {
  it("keeps explicit HTTPS input navigable, including example.com", () => {
    // Regression guard: only implicit startup defaults changed away from the
    // example domain. Deliberately typing it must still work.
    expect(normalizeAddressInput("https://example.com")).toEqual({
      kind: "navigate",
      url: "https://example.com/"
    });
  });

  it("adds https to a bare hostname", () => {
    expect(normalizeAddressInput("example.com")).toEqual({
      kind: "navigate",
      url: "https://example.com/"
    });
    expect(normalizeAddressInput("sub.example.co.uk/path?q=1")).toEqual({
      kind: "navigate",
      url: "https://sub.example.co.uk/path?q=1"
    });
  });

  it("uses http for loopback hosts so local development works", () => {
    expect(normalizeAddressInput("localhost:5173")).toEqual({
      kind: "navigate",
      url: "http://localhost:5173/"
    });
    expect(normalizeAddressInput("127.0.0.1:8080")).toEqual({
      kind: "navigate",
      url: "http://127.0.0.1:8080/"
    });
  });

  it("passes the neutral internal page through", () => {
    expect(normalizeAddressInput(" about:blank ")).toEqual({
      kind: "navigate",
      url: BLANK_PAGE
    });
  });

  it("refuses disallowed schemes rather than silently searching for them", () => {
    // Rewriting these into a search would hide the refusal from the user.
    for (const value of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      expect(normalizeAddressInput(value)).toEqual({
        kind: "rejected",
        reason: "That address scheme is not allowed."
      });
    }
  });

  it("treats free text as a search", () => {
    const decision = normalizeAddressInput("how to build an electron browser");
    expect(decision.kind).toBe("navigate");
    if (decision.kind === "navigate") {
      expect(decision.url).toBe(
        "https://duckduckgo.com/?q=how%20to%20build%20an%20electron%20browser"
      );
    }
  });

  it("treats a dotless word and a bare number as searches, not hosts", () => {
    for (const value of ["chocolate", "3.5", "hello world"]) {
      const decision = normalizeAddressInput(value);
      expect(decision.kind).toBe("navigate");
      if (decision.kind === "navigate") expect(decision.url).toContain("duckduckgo.com");
    }
  });

  it("rejects empty and over-long input", () => {
    expect(normalizeAddressInput("   ").kind).toBe("rejected");
    expect(normalizeAddressInput("a".repeat(MAX_ADDRESS_LENGTH + 1)).kind).toBe("rejected");
  });

  it("honours a caller-supplied search template", () => {
    const decision = normalizeAddressInput("privacy", "https://search.example/?query=%s");
    expect(decision).toEqual({
      kind: "navigate",
      url: "https://search.example/?query=privacy"
    });
  });
});

describe("buildSearchUrl", () => {
  it("encodes the query", () => {
    expect(buildSearchUrl("a&b=c d")).toBe("https://duckduckgo.com/?q=a%26b%3Dc%20d");
  });
});

describe("isSafeFaviconUrl", () => {
  it("accepts only HTTPS favicons", () => {
    expect(isSafeFaviconUrl("https://example.com/favicon.ico")).toBe(true);
  });

  it("refuses plaintext, local, inline, and script favicons", () => {
    for (const value of [
      "http://example.com/favicon.ico",
      "file:///C:/icon.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "javascript:alert(1)",
      "",
      null,
      undefined
    ]) {
      expect(isSafeFaviconUrl(value)).toBe(false);
    }
  });
});

describe("displayHostname", () => {
  it("labels the neutral page as a new tab", () => {
    expect(displayHostname(BLANK_PAGE)).toBe("New tab");
  });

  it("strips the www prefix", () => {
    expect(displayHostname("https://www.example.com/a/b")).toBe("example.com");
  });

  it("falls back for unparseable input", () => {
    expect(displayHostname("nonsense")).toBe("New tab");
  });
});
