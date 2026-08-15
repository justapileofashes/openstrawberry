import { describe, expect, it } from "vitest";
import { isKnownTrackerHost, normalizePrivacyHost, shouldBlockTrackerRequest } from "./privacy.js";

describe("conservative tracker-blocking policy", () => {
  it("normalizes only web-site exceptions and matches explicit tracker-host families", () => {
    expect(normalizePrivacyHost("https://Example.com/path?q=1")).toBe("example.com");
    expect(() => normalizePrivacyHost("file:///private/file")).toThrow("http(s)");
    expect(isKnownTrackerHost("www.google-analytics.com")).toBe(true);
    expect(isKnownTrackerHost("notgoogle-analytics.com")).toBe(false);
  });

  it("blocks known third-party subresources but preserves navigation and site exceptions", () => {
    const base = { url: "https://www.google-analytics.com/analytics.js", referrer: "https://news.example/article", resourceType: "script", enabled: true, allowedHosts: [] };
    expect(shouldBlockTrackerRequest(base)).toBe(true);
    expect(shouldBlockTrackerRequest({ ...base, resourceType: "mainFrame" })).toBe(false);
    expect(shouldBlockTrackerRequest({ ...base, allowedHosts: ["news.example"] })).toBe(false);
    expect(shouldBlockTrackerRequest({ ...base, enabled: false })).toBe(false);
  });
});
