/**
 * Pure helpers for the browser chrome.
 *
 * The layout maths lives here rather than inside components so it can be unit
 * tested: getting pane bounds wrong means native views land in the wrong place
 * or cover the chrome, which is hard to catch by eye and easy to catch here.
 */
import type {
  BrowserPaneId,
  BrowserSnapshot,
  BrowserTabState,
  BrowserViewport
} from "../shared/browser.js";
import type { TabGroup } from "../shared/tab-groups.js";

/**
 * Converts a measured DOM rect into view bounds.
 *
 * Electron positions native views in device-independent pixels, which is the
 * same unit as CSS pixels, so the rect maps across directly. Values are floored
 * to integers because fractional bounds produce a blurred composite, and are
 * clamped at zero because a collapsed pane must not report negative size.
 */
export function viewportFromRect(rect: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): BrowserViewport {
  return {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(0, Math.floor(rect.width)),
    height: Math.max(0, Math.floor(rect.height))
  };
}

export function sameViewport(a: BrowserViewport, b: BrowserViewport): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function tabsForPane(
  snapshot: BrowserSnapshot,
  paneId: BrowserPaneId
): readonly BrowserTabState[] {
  return snapshot.tabs.filter((tab) => tab.paneId === paneId);
}

/** The group a tab belongs to, or null. */
export function groupForTab(
  snapshot: BrowserSnapshot,
  tab: BrowserTabState
): TabGroup | null {
  if (tab.groupId === null) return null;
  return snapshot.groups.find((group) => group.id === tab.groupId) ?? null;
}

/**
 * The tabs a pane's rail actually draws.
 *
 * A collapsed group hides its members - except the active one, which stays
 * visible however its group is set. Hiding the tab a user is looking at would
 * leave the rail describing a window that is not the one in front of them, and
 * no amount of tidiness is worth that.
 *
 * Collapsing never closes or unloads anything; the tabs are still there, still
 * loaded, and still reachable by expanding.
 */
export function railTabsForPane(
  snapshot: BrowserSnapshot,
  paneId: BrowserPaneId
): readonly BrowserTabState[] {
  const active = activeTabId(snapshot, paneId);

  return tabsForPane(snapshot, paneId).filter((tab) => {
    if (tab.id === active) return true;
    const group = groupForTab(snapshot, tab);
    return group === null || !group.collapsed;
  });
}

/** How many members a collapsed group is hiding, for the rail's count badge. */
export function hiddenCountForGroup(
  snapshot: BrowserSnapshot,
  paneId: BrowserPaneId,
  groupId: string
): number {
  const active = activeTabId(snapshot, paneId);

  return tabsForPane(snapshot, paneId).filter(
    (tab) => tab.groupId === groupId && tab.id !== active
  ).length;
}

export function activeTabId(snapshot: BrowserSnapshot, paneId: BrowserPaneId): string | null {
  return snapshot.panes.find((pane) => pane.id === paneId)?.activeTabId ?? null;
}

export function activeTab(
  snapshot: BrowserSnapshot,
  paneId: BrowserPaneId
): BrowserTabState | null {
  const id = activeTabId(snapshot, paneId);
  if (id === null) return null;
  return snapshot.tabs.find((tab) => tab.id === id) ?? null;
}

/** The tab whose address the top bar is editing. */
export function focusedTab(snapshot: BrowserSnapshot): BrowserTabState | null {
  return activeTab(snapshot, snapshot.activePaneId);
}

/** Panes that currently host a visible native view. */
export function visiblePanes(snapshot: BrowserSnapshot): readonly BrowserPaneId[] {
  return snapshot.splitEnabled ? (["primary", "secondary"] as const) : (["primary"] as const);
}

/**
 * The single character shown when a site has no usable favicon.
 *
 * Favicons are the only tab affordance in the rail, so an empty square would
 * make tabs indistinguishable. This never reflects the page title, which is
 * attacker-controlled and could impersonate another site's mark.
 */
export function faviconFallbackLabel(tab: BrowserTabState): string {
  try {
    const host = new URL(tab.url).hostname.replace(/^www\./u, "");
    return (host[0] ?? "•").toUpperCase();
  } catch {
    return "•";
  }
}

/** Accessible name for a rail button, since the control itself is icon-only. */
export function tabAccessibleName(tab: BrowserTabState): string {
  const label = tab.title.trim();
  return label.length > 0 ? label : "New tab";
}
