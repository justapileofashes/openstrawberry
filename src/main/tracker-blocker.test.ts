import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TrackerBlocker, type TrackingBrowserPort } from "./tracker-blocker.js";
import type { TrackingSnapshot } from "../shared/tracking.js";

const TRACKER = "https://www.google-analytics.com/collect";
const ORDINARY = "https://cdn.jsdelivr.net/lib.js";

let statePath = "";
let published: TrackingSnapshot[] = [];
let request: (url: string, webContentsId?: number) => boolean;

/** A tab engine with one focused tab, which is all these tests need. */
function browserWith(
  page: { tabId: string; url: string } | null,
  webContentsId = 7
): TrackingBrowserPort {
  return {
    pageForWebContents: (id) => (id === webContentsId && page !== null ? page : null),
    focusedTab: () => page
  };
}

function build(browser: TrackingBrowserPort): TrackerBlocker {
  let listener:
    | ((
        details: { url: string; webContentsId?: number },
        callback: (response: { cancel: boolean }) => void
      ) => void)
    | null = null;

  const blocker = new TrackerBlocker({
    webRequest: {
      onBeforeRequest: (handler) => {
        listener = handler;
      }
    },
    browser,
    statePath,
    publish: (snapshot) => published.push(snapshot)
  });

  request = (url, webContentsId = 7) => {
    let cancelled = false;
    listener?.({ url, webContentsId }, (response) => {
      cancelled = response.cancel;
    });
    return cancelled;
  };

  return blocker;
}

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), "openstrawberry-tracking-")), "tracking.json");
  published = [];
});

describe("TrackerBlocker", () => {
  const page = { tabId: "tab-1", url: "https://news.example.com/article" };

  it("cancels a known third-party tracker", () => {
    build(browserWith(page));
    expect(request(TRACKER)).toBe(true);
  });

  it("leaves an ordinary third-party request alone", () => {
    build(browserWith(page));
    expect(request(ORDINARY)).toBe(false);
  });

  it("leaves a first-party request alone even under a listed name", () => {
    build(browserWith(page));
    expect(request("https://analytics.example.com/collect")).toBe(false);
  });

  it("counts blocks against the page they happened on", () => {
    const blocker = build(browserWith(page));

    request(TRACKER);
    request("https://doubleclick.net/x");
    request(ORDINARY);

    expect(blocker.snapshot().blockedOnPage).toBe(2);
  });

  it("resets the count when the tab navigates", () => {
    // Derived from the page URL rather than from a navigation event, so the
    // number cannot be left stale by a listener that was never wired up.
    const current = { tabId: "tab-1", url: "https://news.example.com/one" };
    const browser: TrackingBrowserPort = {
      pageForWebContents: (id) => (id === 7 ? current : null),
      focusedTab: () => current
    };

    const blocker = build(browser);
    request(TRACKER);
    expect(blocker.snapshot().blockedOnPage).toBe(1);

    current.url = "https://news.example.com/two";
    request(TRACKER);
    expect(blocker.snapshot().blockedOnPage).toBe(1);
  });

  it("blocks nothing for a request it cannot attribute to a page", () => {
    build(browserWith(page));
    // No WebContents, or one that names no tab: there is no page to judge
    // first-party against, so the request is left alone.
    expect(request(TRACKER, 999)).toBe(false);
  });

  it("stops blocking once disabled, and says so", () => {
    const blocker = build(browserWith(page));

    blocker.setEnabled(false);
    expect(request(TRACKER)).toBe(false);
    expect(blocker.snapshot().enabled).toBe(false);

    blocker.setEnabled(true);
    expect(request(TRACKER)).toBe(true);
  });

  it("excepts the focused site, and resumes it", () => {
    const blocker = build(browserWith(page));

    blocker.exceptSite("tab-1");
    expect(request(TRACKER)).toBe(false);

    const excepted = blocker.snapshot();
    expect(excepted.siteExcepted).toBe(true);
    expect(excepted.exceptions).toEqual(["example.com"]);

    blocker.resumeSite("tab-1");
    expect(request(TRACKER)).toBe(true);
    expect(blocker.snapshot().siteExcepted).toBe(false);
  });

  it("scopes an exception to the site, not the page", () => {
    const blocker = build(browserWith(page));
    blocker.exceptSite("tab-1");

    // Same site, different subdomain and path.
    expect(blocker.snapshot().exceptions).toEqual(["example.com"]);
  });

  it("refuses to except a tab that is not the one in front", () => {
    // The control acts on what the user is looking at; a background tab's site
    // is not that.
    const blocker = build(browserWith(page));
    blocker.exceptSite("tab-99");

    expect(blocker.snapshot().exceptions).toEqual([]);
    expect(request(TRACKER)).toBe(true);
  });

  it("removes an exception by name for the settings list", () => {
    const blocker = build(browserWith(page));
    blocker.exceptSite("tab-1");
    blocker.removeException("example.com");

    expect(blocker.snapshot().exceptions).toEqual([]);
  });

  it("persists exceptions and the switch across a restart", () => {
    const first = build(browserWith(page));
    first.exceptSite("tab-1");
    first.setEnabled(false);
    first.destroy();

    const second = build(browserWith(page));
    const snapshot = second.snapshot();

    expect(snapshot.enabled).toBe(false);
    expect(snapshot.exceptions).toEqual(["example.com"]);
  });

  it("writes no record of what was blocked", () => {
    // The count is the whole interface. A list of blocked URLs would be a
    // browsing history with extra steps.
    const blocker = build(browserWith(page));
    request(TRACKER);
    request("https://doubleclick.net/pixel?id=12345");
    blocker.destroy();

    const written = readFileSync(statePath, "utf8");
    expect(written).not.toContain("google-analytics");
    expect(written).not.toContain("doubleclick");
    expect(written).not.toContain("news.example.com");
  });

  it("reports counts and site names, never a blocked URL", () => {
    const blocker = build(browserWith(page));
    request("https://doubleclick.net/pixel?id=secret-value");

    const serialised = JSON.stringify(blocker.snapshot());
    expect(serialised).not.toContain("secret-value");
    expect(serialised).not.toContain("doubleclick");
  });

  it("allows the request when the policy throws rather than breaking the page", () => {
    const hostile: TrackingBrowserPort = {
      pageForWebContents: () => {
        throw new Error("tab engine is mid-teardown");
      },
      focusedTab: () => null
    };

    build(hostile);
    expect(request(TRACKER)).toBe(false);
  });

  it("tolerates a state file that was damaged on disk", () => {
    writeFileSync(statePath, "{ not json");
    const blocker = build(browserWith(page));

    // Falls back to the shipped default rather than to "off".
    expect(blocker.snapshot().enabled).toBe(true);
    expect(request(TRACKER)).toBe(true);
  });

  it("reports nothing blocked when there is no focused tab", () => {
    const blocker = build(browserWith(null));
    const snapshot = blocker.snapshot();

    expect(snapshot.site).toBe("");
    expect(snapshot.blockedOnPage).toBe(0);
  });

  it("is safe to destroy twice and stops blocking afterwards", () => {
    const blocker = build(browserWith(page));
    blocker.destroy();
    const afterDestroy = published.length;
    blocker.destroy();

    expect(published.length).toBe(afterDestroy);
    expect(request(TRACKER)).toBe(false);
  });

  it("publishes so the chrome never polls", () => {
    build(browserWith(page));
    request(TRACKER);

    expect(published.length).toBeGreaterThan(0);
    expect(published.at(-1)?.blockedOnPage).toBe(1);
  });
});
