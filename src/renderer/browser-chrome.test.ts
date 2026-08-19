import { describe, expect, it } from "vitest";
import { BLANK_PAGE } from "../shared/desktop-shell.js";
import type { BrowserSnapshot, BrowserTabState } from "../shared/browser.js";
import {
  activeTab,
  activeTabId,
  faviconFallbackLabel,
  focusedTab,
  sameViewport,
  groupForTab,
  hiddenCountForGroup,
  railTabsForPane,
  showsCommandCenter,
  tabAccessibleName,
  tabsForPane,
  viewportFromRect,
  visiblePanes
} from "./browser-chrome.js";

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: "tab-1",
    url: "https://example.com/",
    title: "Example",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    isAudible: false,
    paneId: "primary",
    groupId: null,
    ...overrides
  };
}

describe("tab groups in the rail", () => {
  const grouped = (): BrowserSnapshot =>
    snapshot({
      tabs: [
        tab({ id: "tab-1", groupId: "group-1" }),
        tab({ id: "tab-2", groupId: "group-1" }),
        tab({ id: "tab-3", groupId: null })
      ],
      panes: [
        { id: "primary", activeTabId: "tab-1" },
        { id: "secondary", activeTabId: null }
      ],
      groups: [{ id: "group-1", name: "Research", colour: "amber", collapsed: false }]
    });

  it("resolves a tab's group, and null for an ungrouped one", () => {
    const state = grouped();
    expect(groupForTab(state, state.tabs[0] as BrowserTabState)?.name).toBe("Research");
    expect(groupForTab(state, state.tabs[2] as BrowserTabState)).toBeNull();
  });

  it("resolves to null when the group no longer exists", () => {
    const state = snapshot({ tabs: [tab({ groupId: "group-gone" })], groups: [] });
    expect(groupForTab(state, state.tabs[0] as BrowserTabState)).toBeNull();
  });

  it("draws every tab while the group is expanded", () => {
    expect(railTabsForPane(grouped(), "primary").map((t) => t.id)).toEqual([
      "tab-1",
      "tab-2",
      "tab-3"
    ]);
  });

  it("hides collapsed members but never the active tab", () => {
    // Hiding what the user is looking at would leave the rail describing a
    // different window than the one in front of them.
    const state = snapshot({
      ...grouped(),
      groups: [{ id: "group-1", name: "Research", colour: "amber", collapsed: true }]
    });

    expect(railTabsForPane(state, "primary").map((t) => t.id)).toEqual(["tab-1", "tab-3"]);
  });

  it("counts what a collapsed group is hiding", () => {
    const state = snapshot({
      ...grouped(),
      groups: [{ id: "group-1", name: "Research", colour: "amber", collapsed: true }]
    });

    expect(hiddenCountForGroup(state, "primary", "group-1")).toBe(1);
  });
});

function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    tabs: [tab(), tab({ id: "tab-2", paneId: "secondary", url: BLANK_PAGE, title: "" })],
    panes: [
      { id: "primary", activeTabId: "tab-1" },
      { id: "secondary", activeTabId: "tab-2" }
    ],
    activePaneId: "primary",
    splitEnabled: false,
    groups: [],
    ...overrides
  };
}

describe("viewportFromRect", () => {
  it("floors fractional bounds so composited views stay crisp", () => {
    expect(viewportFromRect({ x: 56.4, y: 48.9, width: 1200.7, height: 800.2 })).toEqual({
      x: 56,
      y: 48,
      width: 1200,
      height: 800
    });
  });

  it("clamps negative values a collapsed pane can produce", () => {
    expect(viewportFromRect({ x: -10, y: -5, width: -100, height: 0 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0
    });
  });
});

describe("sameViewport", () => {
  it("detects equality so unchanged bounds are not resent every frame", () => {
    const a = { x: 1, y: 2, width: 3, height: 4 };
    expect(sameViewport(a, { ...a })).toBe(true);
    expect(sameViewport(a, { ...a, width: 9 })).toBe(false);
  });
});

describe("pane selectors", () => {
  it("partitions tabs by pane", () => {
    expect(tabsForPane(snapshot(), "primary").map((entry) => entry.id)).toEqual(["tab-1"]);
    expect(tabsForPane(snapshot(), "secondary").map((entry) => entry.id)).toEqual(["tab-2"]);
  });

  it("resolves the active tab per pane", () => {
    expect(activeTabId(snapshot(), "secondary")).toBe("tab-2");
    expect(activeTab(snapshot(), "primary")?.id).toBe("tab-1");
  });

  it("returns null for a pane with no tabs", () => {
    const empty = snapshot({ panes: [{ id: "primary", activeTabId: null }] });
    expect(activeTabId(empty, "primary")).toBeNull();
    expect(activeTab(empty, "primary")).toBeNull();
    expect(activeTabId(empty, "secondary")).toBeNull();
  });

  it("follows the active pane for the address bar", () => {
    expect(focusedTab(snapshot())?.id).toBe("tab-1");
    expect(focusedTab(snapshot({ activePaneId: "secondary" }))?.id).toBe("tab-2");
  });

  it("reports only the primary pane as visible until split is enabled", () => {
    expect(visiblePanes(snapshot())).toEqual(["primary"]);
    expect(visiblePanes(snapshot({ splitEnabled: true }))).toEqual(["primary", "secondary"]);
  });
});

describe("showsCommandCenter", () => {
  it("gives a new tab's area to the command center", () => {
    expect(showsCommandCenter(snapshot({ activePaneId: "secondary" }), "secondary")).toBe(true);
  });

  it("leaves a pane showing a real page alone", () => {
    // The native view is composited into the pane's bounds, so drawing here
    // while a page is loaded would put the surface behind it.
    expect(showsCommandCenter(snapshot(), "primary")).toBe(false);
  });

  it("hands the area back the moment the tab navigates", () => {
    const navigated = snapshot({
      tabs: [tab({ id: "tab-1", url: "https://example.com/" })],
      panes: [
        { id: "primary", activeTabId: "tab-1" },
        { id: "secondary", activeTabId: null }
      ]
    });

    expect(showsCommandCenter(navigated, "primary")).toBe(false);
  });

  it("draws nothing for a pane holding no tab at all", () => {
    // An empty pane is not a new tab, and inventing one would put a surface in
    // a pane the user never opened anything in.
    const empty = snapshot({
      tabs: [],
      panes: [
        { id: "primary", activeTabId: null },
        { id: "secondary", activeTabId: null }
      ]
    });

    expect(showsCommandCenter(empty, "primary")).toBe(false);
  });
});

describe("faviconFallbackLabel", () => {
  it("uses the first letter of the host", () => {
    expect(faviconFallbackLabel(tab({ url: "https://www.example.com/" }))).toBe("E");
    expect(faviconFallbackLabel(tab({ url: "https://news.ycombinator.com/" }))).toBe("N");
  });

  it("never derives the mark from an attacker-controlled title", () => {
    // A page claiming to be another site must not be able to borrow its letter.
    expect(faviconFallbackLabel(tab({ url: BLANK_PAGE, title: "Google" }))).toBe("•");
  });
});

describe("tabAccessibleName", () => {
  it("names icon-only rail buttons for assistive technology", () => {
    expect(tabAccessibleName(tab({ title: "Example" }))).toBe("Example");
    expect(tabAccessibleName(tab({ title: "   " }))).toBe("New tab");
  });
});
