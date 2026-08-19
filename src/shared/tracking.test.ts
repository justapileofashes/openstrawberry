import { describe, expect, it } from "vitest";
import {
  decideRequest,
  emptyTrackingState,
  hostOf,
  isHostWithin,
  isSameSite,
  isTrackerHost,
  MAX_EXCEPTIONS,
  normalizeHost,
  parseExceptionSite,
  parseTrackingEnabledPayload,
  parseTrackingSitePayload,
  parseTrackingState,
  registrableDomain,
  TRACKER_HOSTS,
  TRACKING_STATE_VERSION
} from "./tracking.js";

const ON = { enabled: true, exceptions: new Set<string>() };

describe("TRACKER_HOSTS", () => {
  it("is a list a person can actually review", () => {
    // The feature's claim is that it is short and inspectable. A list that grows
    // past this is a different feature and needs a different justification.
    expect(TRACKER_HOSTS.length).toBeLessThan(80);
  });

  it("holds no duplicates", () => {
    expect(new Set(TRACKER_HOSTS).size).toBe(TRACKER_HOSTS.length);
  });

  it("is pure ASCII lowercase, so no homoglyph can hide in it", () => {
    for (const host of TRACKER_HOSTS) {
      expect(host).toMatch(/^[a-z0-9.-]+$/u);
      expect(host).toBe(host.toLowerCase());
    }
  });

  it("blocks nothing a page needs to function", () => {
    // Payments, CDNs, fonts, captchas, consent, and error reporting change what
    // a page can do rather than who is watching it.
    const mustNotBlock = [
      "stripe.com",
      "paypal.com",
      "cloudflare.com",
      "jsdelivr.net",
      "unpkg.com",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "recaptcha.net",
      "hcaptcha.com",
      "sentry.io",
      "gravatar.com"
    ];

    for (const host of mustNotBlock) expect(isTrackerHost(host)).toBe(false);
  });
});

describe("normalizeHost", () => {
  it("lowercases and drops a trailing dot", () => {
    expect(normalizeHost("Example.COM.")).toBe("example.com");
    expect(normalizeHost("  example.com  ")).toBe("example.com");
  });

  it("refuses nothing and over-long names", () => {
    expect(normalizeHost("")).toBe("");
    expect(normalizeHost("a".repeat(300))).toBe("");
  });
});

describe("hostOf", () => {
  it("extracts a hostname", () => {
    expect(hostOf("https://Sub.Example.com/path?q=1")).toBe("sub.example.com");
  });

  it("returns empty for anything that is not a URL", () => {
    for (const value of ["", "nonsense", "about:blank"]) expect(hostOf(value)).toBe("");
  });
});

describe("registrableDomain", () => {
  it("reduces a subdomain to its site", () => {
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("understands multi-label public suffixes", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
  });

  it("leaves an IP literal alone", () => {
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    expect(registrableDomain("192.168.1.10")).toBe("192.168.1.10");
  });

  it("leaves a single label alone", () => {
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});

describe("isHostWithin", () => {
  it("matches a domain and its subdomains, and nothing else", () => {
    expect(isHostWithin("a.example.com", "example.com")).toBe(true);
    expect(isHostWithin("example.com", "example.com")).toBe(true);
    // The suffix check must not match a name that merely ends with the letters.
    expect(isHostWithin("notexample.com", "example.com")).toBe(false);
    expect(isHostWithin("example.com.evil.net", "example.com")).toBe(false);
  });
});

describe("isSameSite", () => {
  it("treats subdomains of one site as the same site", () => {
    expect(isSameSite("cdn.example.com", "www.example.com")).toBe(true);
  });

  it("keeps distinct sites distinct", () => {
    expect(isSameSite("evil.com", "example.com")).toBe(false);
    // Two sites under one public suffix are not the same site.
    expect(isSameSite("a.co.uk", "b.co.uk")).toBe(false);
  });
});

describe("decideRequest", () => {
  const page = "https://news.example.com/article";

  it("blocks a known third-party tracker", () => {
    expect(decideRequest("https://www.google-analytics.com/collect", page, ON)).toEqual({
      blocked: true,
      reason: "tracker"
    });
  });

  it("blocks a subdomain of a listed host", () => {
    expect(decideRequest("https://a.b.doubleclick.net/x", page, ON).blocked).toBe(true);
  });

  it("leaves ordinary third-party requests alone", () => {
    expect(decideRequest("https://cdn.jsdelivr.net/lib.js", page, ON)).toEqual({
      blocked: false,
      reason: "not-a-tracker"
    });
  });

  it("never blocks a site talking to itself, even a listed name", () => {
    // The conservative rule: CNAME-cloaked tracking is given up on deliberately,
    // because catching it means breaking requests a site makes to itself.
    const decision = decideRequest(
      "https://analytics.example.com/collect",
      page,
      ON
    );
    expect(decision).toEqual({ blocked: false, reason: "first-party" });
  });

  it("honours a per-site exception", () => {
    const context = { enabled: true, exceptions: new Set(["example.com"]) };
    expect(decideRequest("https://www.google-analytics.com/collect", page, context)).toEqual({
      blocked: false,
      reason: "site-exception"
    });
  });

  it("applies an exception to the whole site, subdomains included", () => {
    const context = { enabled: true, exceptions: new Set(["example.com"]) };
    const decision = decideRequest(
      "https://doubleclick.net/x",
      "https://deep.sub.example.com/page",
      context
    );
    expect(decision.blocked).toBe(false);
  });

  it("blocks nothing at all when disabled", () => {
    const context = { enabled: false, exceptions: new Set<string>() };
    expect(decideRequest("https://www.google-analytics.com/collect", page, context)).toEqual({
      blocked: false,
      reason: "disabled"
    });
  });

  it("leaves a request alone when the page has no host", () => {
    // A tracker is still a tracker without a referring page, but about:blank has
    // no site to except, so the safe answer is the list's answer.
    expect(decideRequest("https://doubleclick.net/x", "about:blank", ON).blocked).toBe(true);
  });

  it("leaves an unparseable request alone", () => {
    expect(decideRequest("nonsense", page, ON)).toEqual({
      blocked: false,
      reason: "not-a-tracker"
    });
  });

  it("is not fooled by a tracker name appearing inside another host", () => {
    for (const url of [
      "https://google-analytics.com.evil.net/x",
      "https://notdoubleclick.net/x",
      "https://doubleclick.net.attacker.io/x"
    ]) {
      expect(decideRequest(url, page, ON).blocked).toBe(false);
    }
  });
});

describe("parseExceptionSite", () => {
  it("reduces whatever it is given to a registrable domain", () => {
    expect(parseExceptionSite("deep.sub.example.co.uk", "Site")).toBe("example.co.uk");
    expect(parseExceptionSite("EXAMPLE.COM", "Site")).toBe("example.com");
  });

  it("refuses anything that does not name a site", () => {
    for (const hostile of [null, 42, "", " ", "a".repeat(300)]) {
      expect(() => parseExceptionSite(hostile, "Site")).toThrow();
    }
  });
});

describe("payload validators", () => {
  it("accepts well-formed payloads", () => {
    expect(parseTrackingSitePayload({ tabId: "tab-1" })).toEqual({ tabId: "tab-1" });
    expect(parseTrackingEnabledPayload({ enabled: false })).toEqual({ enabled: false });
  });

  it("refuses malformed ones without coercing", () => {
    for (const hostile of [null, [], "tab-1", { tabId: 1 }, { tabId: "" }]) {
      expect(() => parseTrackingSitePayload(hostile)).toThrow();
    }
    // No coercion: a truthy string is not a boolean.
    for (const hostile of [null, {}, { enabled: "true" }, { enabled: 1 }]) {
      expect(() => parseTrackingEnabledPayload(hostile)).toThrow();
    }
  });
});

describe("persistence", () => {
  it("defaults to enabled, because a privacy feature nobody finds is not one", () => {
    expect(emptyTrackingState().enabled).toBe(true);
    expect(parseTrackingState(null).enabled).toBe(true);
  });

  it("round-trips exceptions", () => {
    const state = parseTrackingState({
      version: TRACKING_STATE_VERSION,
      enabled: false,
      exceptions: ["example.com", "other.co.uk"]
    });

    expect(state.enabled).toBe(false);
    expect(state.exceptions).toEqual(["example.com", "other.co.uk"]);
  });

  it("re-reduces a hand-edited entry so it cannot match more broadly", () => {
    // "co.uk" as an exception would except every site under it.
    const state = parseTrackingState({
      version: TRACKING_STATE_VERSION,
      enabled: true,
      exceptions: ["deep.sub.example.com", "co.uk"]
    });

    expect(state.exceptions).toContain("example.com");
    expect(state.exceptions).not.toContain("deep.sub.example.com");
  });

  it("drops duplicates and unreadable entries", () => {
    const state = parseTrackingState({
      version: TRACKING_STATE_VERSION,
      enabled: true,
      exceptions: ["example.com", "www.example.com", 42, null, ""]
    });

    expect(state.exceptions).toEqual(["example.com"]);
  });

  it("bounds a file claiming more exceptions than the cap", () => {
    const state = parseTrackingState({
      version: TRACKING_STATE_VERSION,
      enabled: true,
      exceptions: Array.from({ length: MAX_EXCEPTIONS + 200 }, (_u, i) => `site${i}.com`)
    });

    expect(state.exceptions.length).toBeLessThanOrEqual(MAX_EXCEPTIONS);
  });

  it("returns defaults for anything unreadable or of the wrong version", () => {
    for (const hostile of [null, 42, "text", [], { version: 99 }]) {
      expect(parseTrackingState(hostile)).toEqual(emptyTrackingState());
    }
  });
});
