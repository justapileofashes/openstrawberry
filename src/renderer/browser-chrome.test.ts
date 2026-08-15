import { describe, expect, it } from "vitest";
import { faviconUrlForTab } from "./browser-chrome.js";

describe("faviconUrlForTab", () => {
  it("derives a same-origin favicon URL for web tabs", () => {
    expect(faviconUrlForTab("https://openrouter.ai/docs/models?sort=name")).toBe("https://openrouter.ai/favicon.ico");
  });

  it("retains an explicit HTTP origin when the tab uses HTTP", () => {
    expect(faviconUrlForTab("http://localhost:5173/workspace")).toBe("http://localhost:5173/favicon.ico");
  });

  it("does not create an image URL for malformed or non-web values", () => {
    expect(faviconUrlForTab("not a URL")).toBeNull();
    expect(faviconUrlForTab("file:///private/local.html")).toBeNull();
  });
});
