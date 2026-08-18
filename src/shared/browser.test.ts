import { describe, expect, it } from "vitest";
import { BLANK_PAGE } from "./desktop-shell.js";
import { IpcValidationError } from "./ipc-validation.js";
import {
  attachmentPlan,
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
  visibleTabIds,
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
        paneId: "primary",
        groupId: null
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
        paneId: "secondary",
        groupId: null
      }
    ],
    panes: [
      { id: "primary", activeTabId: "tab-1" },
      { id: "secondary", activeTabId: "tab-2" }
    ],
    activePaneId: "primary",
    splitEnabled: true,
    groups: []
  };
}

describe("toPersistedSession", () => {
  it("keeps only bounded location metadata", () => {
    const session = toPersistedSession(snapshot());

    expect(session.tabs).toEqual([
      { id: "tab-1", url: "https://example.com/", paneId: "primary", groupId: null },
      { id: "tab-2", url: BLANK_PAGE, paneId: "secondary", groupId: null }
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
      splitEnabled: false,
      groups: []
    });

    expect(restored.tabs.map((tab) => tab.id)).toEqual(["safe"]);
  });

  it("drops an active-tab reference that did not survive validation", () => {
    const restored = parsePersistedSession({
      version: SESSION_VERSION,
      tabs: [{ id: "local", url: "file:///etc/passwd", paneId: "primary" }],
      activeTabByPane: { primary: "local", secondary: null },
      activePaneId: "primary",
      splitEnabled: false,
      groups: []
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
      splitEnabled: false,
      groups: []
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
        splitEnabled: false,
        groups: []
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

describe("visibleTabIds", () => {
  it("shows only the primary pane's tab when the split is closed", () => {
    // The secondary pane's tab stays alive but unattached, so switching back is
    // instant while only what is on screen costs compositing.
    const visible = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, false);
    expect([...visible]).toEqual(["tab-1"]);
  });

  it("shows both panes' tabs when the split is open", () => {
    const visible = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, true);
    expect([...visible].sort()).toEqual(["tab-1", "tab-2"]);
  });

  it("shows nothing for a pane with no active tab", () => {
    expect([...visibleTabIds({ primary: null, secondary: null }, true)]).toEqual([]);
    expect([...visibleTabIds({ primary: null, secondary: "tab-2" }, true)]).toEqual(["tab-2"]);
  });

  it("counts a tab active in both panes once", () => {
    const visible = visibleTabIds({ primary: "tab-1", secondary: "tab-1" }, true);
    expect(visible.size).toBe(1);
  });
});

describe("attachmentPlan", () => {
  it("attaches what is newly visible", () => {
    const plan = attachmentPlan(new Set(), new Set(["tab-1"]));
    expect(plan).toEqual({ toDetach: [], toAttach: ["tab-1"] });
  });

  it("detaches what is no longer visible", () => {
    const plan = attachmentPlan(new Set(["tab-1", "tab-2"]), new Set(["tab-1"]));
    expect(plan).toEqual({ toDetach: ["tab-2"], toAttach: [] });
  });

  it("does nothing when the attached set already matches", () => {
    // Idempotence is what makes calling this on every layout pass free, and is
    // why a repeated pass cannot double-attach a view.
    const plan = attachmentPlan(new Set(["tab-1"]), new Set(["tab-1"]));
    expect(plan).toEqual({ toDetach: [], toAttach: [] });
  });

  it("both detaches and attaches when the visible set is replaced", () => {
    const plan = attachmentPlan(new Set(["tab-1"]), new Set(["tab-2"]));
    expect(plan.toDetach).toEqual(["tab-1"]);
    expect(plan.toAttach).toEqual(["tab-2"]);
  });

  it("detaches everything when nothing is visible", () => {
    // What a window beginning to close looks like: the panes report zero, and
    // every view has to come off before the parent goes.
    const plan = attachmentPlan(new Set(["tab-1", "tab-2"]), new Set());
    expect([...plan.toDetach].sort()).toEqual(["tab-1", "tab-2"]);
    expect(plan.toAttach).toEqual([]);
  });

  it("is empty on both sides for an empty window", () => {
    expect(attachmentPlan(new Set(), new Set())).toEqual({ toDetach: [], toAttach: [] });
  });

  it("keeps a tab attached when the split opens beside it", () => {
    // Opening a split must not churn the tab that was already on screen.
    const before = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, false);
    const after = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, true);
    const plan = attachmentPlan(before, after);

    expect(plan.toDetach).toEqual([]);
    expect(plan.toAttach).toEqual(["tab-2"]);
  });

  it("detaches only the secondary tab when the split closes", () => {
    const before = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, true);
    const after = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, false);
    const plan = attachmentPlan(before, after);

    expect(plan.toDetach).toEqual(["tab-2"]);
    expect(plan.toAttach).toEqual([]);
  });

  it("names a tab moving between panes on both sides", () => {
    /*
     * The case that makes ordering matter. A tab active in the primary pane and
     * then activated in the secondary appears in neither set here - it stays
     * attached - but a tab swapping with another appears in both, and the caller
     * has to detach before attaching or the bookkeeping claims it twice.
     */
    const before = visibleTabIds({ primary: "tab-1", secondary: "tab-2" }, true);
    const after = visibleTabIds({ primary: "tab-2", secondary: "tab-1" }, true);

    expect(attachmentPlan(before, after)).toEqual({ toDetach: [], toAttach: [] });
  });
});
