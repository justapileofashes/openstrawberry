import { describe, expect, it } from "vitest";
import { BLANK_PAGE } from "./desktop-shell.js";
import { IpcValidationError } from "./ipc-validation.js";
import {
  emptySession,
  MAX_TABS,
  parseActivePanePayload,
  parseCreateTabPayload,
  parseMoveTabPayload,
  parseNavigatePayload,
  parsePersistedSession,
  parseSplitPayload,
  parseTabIdPayload,
  parseViewportPayload,
  SESSION_VERSION,
  toPersistedSession,
  type BrowserSnapshot
} from "./browser.js";

function snapshot(): BrowserSnapshot {
  return {
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example",
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        faviconUrl: "https://example.com/favicon.ico",
        isAudible: false,
        paneId: "primary"
      },
      {
        id: "tab-2",
        url: BLANK_PAGE,
        title: "New tab",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        isAudible: false,
        paneId: "secondary"
      }
    ],
    panes: [
      { id: "primary", activeTabId: "tab-1" },
      { id: "secondary", activeTabId: "tab-2" }
    ],
    activePaneId: "primary",
    splitEnabled: true
  };
}

describe("toPersistedSession", () => {
  it("keeps only bounded location metadata", () => {
    const session = toPersistedSession(snapshot());

    expect(session.tabs).toEqual([
      { id: "tab-1", url: "https://example.com/", paneId: "primary" },
      { id: "tab-2", url: BLANK_PAGE, paneId: "secondary" }
    ]);
    expect(session.activeTabByPane).toEqual({ primary: "tab-1", secondary: "tab-2" });
    expect(session.splitEnabled).toBe(true);
  });

  it("carries no display state that could grow unbounded or identify a user", () => {
    const serialized = JSON.stringify(toPersistedSession(snapshot()));

    // Titles and favicons are display-only and are not worth persisting; more
    // importantly the shape has nowhere to put credentials at all.
    for (const forbidden of ["title", "favicon", "cookie", "token", "password", "Example"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("round-trips through the parser", () => {
    const session = toPersistedSession(snapshot());
    expect(parsePersistedSession(JSON.parse(JSON.stringify(session)))).toEqual(session);
  });
});

describe("parsePersistedSession", () => {
  it("returns an empty session for corrupt or foreign input", () => {
    for (const value of [null, undefined, 42, "{}", [], {}, { version: 99 }]) {
      expect(parsePersistedSession(value)).toEqual(emptySession());
    }
  });

  it("drops tabs whose URL the navigation policy refuses", () => {
    const restored = parsePersistedSession({
      version: SESSION_VERSION,
      tabs: [
        { id: "safe", url: "https://example.com/", paneId: "primary" },
        { id: "local", url: "file:///etc/passwd", paneId: "primary" },
        { id: "script", url: "javascript:alert(1)", paneId: "primary" },
        { id: "creds", url: "https://user:pass@example.com/", paneId: "primary" }
      ],
      activeTabByPane: { primary: "safe", secondary: null },
      activePaneId: "primary",
      splitEnabled: false
    });

    expect(restored.tabs.map((tab) => tab.id)).toEqual(["safe"]);
  });

  it("drops an active-tab reference that did not survive validation", () => {
    const restored = parsePersistedSession({
      version: SESSION_VERSION,
      tabs: [{ id: "local", url: "file:///etc/passwd", paneId: "primary" }],
      activeTabByPane: { primary: "local", secondary: null },
      activePaneId: "primary",
      splitEnabled: false
    });

    expect(restored.tabs).toHaveLength(0);
    expect(restored.activeTabByPane.primary).toBeNull();
  });

  it("drops duplicate tab ids", () => {
    const restored = parsePersistedSession({
      version: SESSION_VERSION,
      tabs: [
        { id: "dupe", url: "https://a.example/", paneId: "primary" },
        { id: "dupe", url: "https://b.example/", paneId: "primary" }
      ],
      activeTabByPane: { primary: "dupe", secondary: null },
      activePaneId: "primary",
      splitEnabled: false
    });

    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.url).toBe("https://a.example/");
  });

  it("refuses a tab list longer than the bound", () => {
    const tabs = Array.from({ length: MAX_TABS + 1 }, (_, index) => ({
      id: `tab-${index}`,
      url: "https://example.com/",
      paneId: "primary" as const
    }));

    expect(
      parsePersistedSession({
        version: SESSION_VERSION,
        tabs,
        activeTabByPane: { primary: null, secondary: null },
        activePaneId: "primary",
        splitEnabled: false
      })
    ).toEqual(emptySession());
  });
});

describe("IPC payload parsers", () => {
  it("parses a viewport", () => {
    expect(
      parseViewportPayload({
        paneId: "primary",
        viewport: { x: 72, y: 48, width: 1200, height: 800 }
      })
    ).toEqual({ paneId: "primary", viewport: { x: 72, y: 48, width: 1200, height: 800 } });
  });

  it("refuses malformed viewports", () => {
    for (const value of [
      { paneId: "primary", viewport: { x: 0, y: 0, width: -1, height: 10 } },
      { paneId: "primary", viewport: { x: 0, y: 0, width: 10.5, height: 10 } },
      { paneId: "primary", viewport: { x: 0, y: 0, width: "10", height: 10 } },
      { paneId: "tertiary", viewport: { x: 0, y: 0, width: 10, height: 10 } },
      { paneId: "primary" },
      {}
    ]) {
      expect(() => parseViewportPayload(value)).toThrow(IpcValidationError);
    }
  });

  it("defaults a new tab to the neutral page and refuses unsafe requested URLs", () => {
    expect(parseCreateTabPayload({ paneId: "primary" }).url).toBe(BLANK_PAGE);
    expect(parseCreateTabPayload({ paneId: "primary", url: "file:///etc/passwd" }).url).toBe(
      BLANK_PAGE
    );
    expect(parseCreateTabPayload({ paneId: "primary", url: "https://example.com/" }).url).toBe(
      "https://example.com/"
    );
  });

  it("parses tab, navigate, move, split, and pane payloads", () => {
    expect(parseTabIdPayload({ tabId: "tab-1" })).toEqual({ tabId: "tab-1" });
    expect(parseNavigatePayload({ tabId: "tab-1", address: "example.com" })).toEqual({
      tabId: "tab-1",
      address: "example.com"
    });
    expect(parseMoveTabPayload({ tabId: "tab-1", paneId: "secondary" })).toEqual({
      tabId: "tab-1",
      paneId: "secondary"
    });
    expect(parseSplitPayload({ enabled: true })).toBe(true);
    expect(parseActivePanePayload({ paneId: "secondary" })).toBe("secondary");
  });

  it("refuses tab ids that could escape an identifier context", () => {
    for (const tabId of ["../../etc", "tab 1", "", 7, null]) {
      expect(() => parseTabIdPayload({ tabId })).toThrow(IpcValidationError);
    }
  });
});
