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
