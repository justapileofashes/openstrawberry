/**
 * Browser state contracts shared by the main process and the chrome.
 *
 * Two rules govern everything here:
 *
 *   - Snapshots are what the renderer is allowed to know. They carry no
 *     credentials, cookies, tokens, or local paths — only bounded display
 *     metadata.
 *   - Persisted sessions are deliberately narrower still. OpenStrawberry
 *     restores where you were, never who you were signed in as.
 */

import {
  MAX_COLLECTION_LENGTH,
  MAX_URL_LENGTH,
  requireArray,
  requireBoolean,
  requireIdentifier,
  requireInteger,
  requireOneOf,
  requirePlainObject,
  requireString
} from "./ipc-validation.js";
import { BLANK_PAGE } from "./desktop-shell.js";
import { isAllowedUrl } from "./navigation.js";
import { parseTabGroups, pruneEmptyGroups, type TabGroup } from "./tab-groups.js";

export const PANE_IDS = ["primary", "secondary"] as const;
export type BrowserPaneId = (typeof PANE_IDS)[number];

/** Guards against a runaway renderer opening unbounded native views. */
export const MAX_TABS = 100;

/** Bounds pane geometry to something a real display could produce. */
export const MAX_VIEWPORT_DIMENSION = 20_000;

export interface BrowserViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserTabState {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Null unless the site supplied an HTTPS favicon. */
  readonly faviconUrl: string | null;
  readonly isAudible: boolean;
  readonly paneId: BrowserPaneId;
  /**
   * The group this tab belongs to, or null.
   *
   * Membership lives here rather than as a list of tab ids on the group, so a
   * tab is in at most one group by construction and closing one cannot leave a
   * group referring to something gone.
   */
  readonly groupId: string | null;
}

export interface BrowserPaneState {
  readonly id: BrowserPaneId;
  readonly activeTabId: string | null;
}

export interface BrowserSnapshot {
  readonly tabs: readonly BrowserTabState[];
  readonly panes: readonly BrowserPaneState[];
  readonly activePaneId: BrowserPaneId;
  readonly splitEnabled: boolean;
  readonly groups: readonly TabGroup[];
}

/* ------------------------------------------------------------------------- */
/* Persisted session                                                          */
/* ------------------------------------------------------------------------- */

export const SESSION_VERSION = 1;

export interface PersistedTab {
  readonly id: string;
  readonly url: string;
  readonly paneId: BrowserPaneId;
  readonly groupId: string | null;
}

/* ------------------------------------------------------------------------- */
/* Attachment bookkeeping                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Which tabs should be attached to the window right now.
 *
 * Exactly the active tab of each visible pane. An inactive tab stays alive but
 * unattached, so switching back is instant while only what is on screen costs
 * compositing.
 *
 * Pure, because getting this wrong is how native views end up composited over
 * the chrome or left attached to a window that is closing - both of which are
 * hard to see by eye and easy to check here.
 */
export function visibleTabIds(
  activeByPane: Readonly<Record<BrowserPaneId, string | null>>,
  splitEnabled: boolean
): ReadonlySet<string> {
  const panes: readonly BrowserPaneId[] = splitEnabled ? PANE_IDS : ["primary"];

  const visible = new Set<string>();
  for (const paneId of panes) {
    const tabId = activeByPane[paneId];
    if (tabId !== null) visible.add(tabId);
  }

  return visible;
}

/**
 * What to detach and what to attach, given what is attached now.
 *
 * Detachments are listed first because the caller must apply them first: a tab
 * moving between panes appears in both sets, and attaching before detaching
 * would leave the bookkeeping claiming it twice.
 */
export function attachmentPlan(
  attached: ReadonlySet<string>,
  visible: ReadonlySet<string>
): { readonly toDetach: readonly string[]; readonly toAttach: readonly string[] } {
  const toDetach: string[] = [];
  for (const tabId of attached) {
    if (!visible.has(tabId)) toDetach.push(tabId);
  }

  const toAttach: string[] = [];
  for (const tabId of visible) {
    if (!attached.has(tabId)) toAttach.push(tabId);
  }

  return { toDetach, toAttach };
}

export interface PersistedSession {
  readonly version: number;
  readonly tabs: readonly PersistedTab[];
  readonly activeTabByPane: Readonly<Record<BrowserPaneId, string | null>>;
  readonly activePaneId: BrowserPaneId;
  readonly splitEnabled: boolean;
  readonly groups: readonly TabGroup[];
}

export function emptySession(): PersistedSession {
  return {
    version: SESSION_VERSION,
    tabs: [],
    activeTabByPane: { primary: null, secondary: null },
    activePaneId: "primary",
    splitEnabled: false,
    groups: []
  };
}

/**
 * Reduces a live snapshot to the bounded subset worth persisting.
 *
 * Note what is structurally impossible to persist here: there is no field for
 * cookies, session tokens, passkeys, payment data, passwords, or API keys. The
 * shape is the guarantee.
 */
export function toPersistedSession(snapshot: BrowserSnapshot): PersistedSession {
  const activeTabByPane: Record<BrowserPaneId, string | null> = {
    primary: null,
    secondary: null
  };

  for (const pane of snapshot.panes) activeTabByPane[pane.id] = pane.activeTabId;

  return {
    version: SESSION_VERSION,
    tabs: snapshot.tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      paneId: tab.paneId,
      groupId: tab.groupId
    })),
    activeTabByPane,
    activePaneId: snapshot.activePaneId,
    splitEnabled: snapshot.splitEnabled,
    // Only groups something still belongs to. An emptied group has no rail
    // presence and no way to be reached again.
    groups: pruneEmptyGroups(
      snapshot.groups,
      snapshot.tabs.map((tab) => tab.groupId)
    )
  };
}

/**
 * Parses a session file written by an earlier run.
 *
 * The file is on disk and could have been edited, so it is treated as
 * untrusted: unknown versions, disallowed URLs, and dangling active-tab
 * references are dropped rather than trusted. A corrupt file yields an empty
 * session instead of throwing, so a bad file can never wedge startup.
 */
export function parsePersistedSession(raw: unknown): PersistedSession {
  try {
    const root = requirePlainObject(raw, "Session");
    if (requireInteger(root["version"], "Session version", 1, 1_000) !== SESSION_VERSION) {
      return emptySession();
    }

    const rawTabs = requireArray(root["tabs"], "Session tabs", MAX_TABS);
    const tabs: PersistedTab[] = [];
    const seen = new Set<string>();

    for (const entry of rawTabs) {
      const tab = requirePlainObject(entry, "Session tab");
      const id = requireIdentifier(tab["id"], "Session tab id");
      const url = requireString(tab["url"], "Session tab URL", MAX_URL_LENGTH);
      const paneId = requireOneOf(tab["paneId"], PANE_IDS, "Session tab pane");

      // A restored URL goes through exactly the same policy as a typed one.
      if (!isAllowedUrl(url)) continue;
      if (seen.has(id)) continue;

      const rawGroupId = tab["groupId"];
      const groupId =
        typeof rawGroupId === "string" ? requireIdentifier(rawGroupId, "Session tab group") : null;

      seen.add(id);
      tabs.push({ id, url, paneId, groupId });
    }

    /*
     * Groups are read after the tabs, then reduced to those something actually
     * belongs to, and finally each tab's membership is checked against what
     * survived. A hand-edited file naming a group that is not in the list leaves
     * the tab ungrouped rather than pointing at nothing.
     */
    const parsedGroups = parseTabGroups(root["groups"]);
    const groupIds = new Set(parsedGroups.map((group) => group.id));

    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      if (tab === undefined || tab.groupId === null) continue;
      if (!groupIds.has(tab.groupId)) tabs[index] = { ...tab, groupId: null };
    }

    const groups = pruneEmptyGroups(
      parsedGroups,
      tabs.map((tab) => tab.groupId)
    );

    const rawActive = requirePlainObject(root["activeTabByPane"], "Session active tabs");
    const activeTabByPane: Record<BrowserPaneId, string | null> = {
      primary: null,
      secondary: null
    };

    for (const paneId of PANE_IDS) {
      const value = rawActive[paneId];
      if (typeof value !== "string") continue;
      // Drop references to tabs that did not survive validation.
      if (seen.has(value)) activeTabByPane[paneId] = value;
    }

    return {
      version: SESSION_VERSION,
      tabs,
      activeTabByPane,
      activePaneId: requireOneOf(root["activePaneId"], PANE_IDS, "Session active pane"),
      splitEnabled: requireBoolean(root["splitEnabled"], "Session split state"),
      groups
    };
  } catch {
    return emptySession();
  }
}

/* ------------------------------------------------------------------------- */
/* IPC payload parsers                                                        */
/* ------------------------------------------------------------------------- */

export interface ViewportPayload {
  readonly paneId: BrowserPaneId;
  readonly viewport: BrowserViewport;
}

export function parseViewportPayload(raw: unknown): ViewportPayload {
  const root = requirePlainObject(raw, "Viewport payload");
  const viewport = requirePlainObject(root["viewport"], "Viewport");

  return {
    paneId: requireOneOf(root["paneId"], PANE_IDS, "Pane"),
    viewport: {
      x: requireInteger(viewport["x"], "Viewport x", -MAX_VIEWPORT_DIMENSION, MAX_VIEWPORT_DIMENSION),
      y: requireInteger(viewport["y"], "Viewport y", -MAX_VIEWPORT_DIMENSION, MAX_VIEWPORT_DIMENSION),
      width: requireInteger(viewport["width"], "Viewport width", 0, MAX_VIEWPORT_DIMENSION),
      height: requireInteger(viewport["height"], "Viewport height", 0, MAX_VIEWPORT_DIMENSION)
    }
  };
}

export interface NavigatePayload {
  readonly tabId: string;
  readonly address: string;
}

export function parseNavigatePayload(raw: unknown): NavigatePayload {
  const root = requirePlainObject(raw, "Navigate payload");
  return {
    tabId: requireIdentifier(root["tabId"], "Tab ID"),
    address: requireString(root["address"], "Address", MAX_URL_LENGTH)
  };
}

export interface CreateTabPayload {
  readonly paneId: BrowserPaneId;
  readonly url: string;
}

export function parseCreateTabPayload(raw: unknown): CreateTabPayload {
  const root = requirePlainObject(raw, "Create tab payload");
  const url = root["url"];

  return {
    paneId: requireOneOf(root["paneId"], PANE_IDS, "Pane"),
    // Every new tab starts neutral unless the caller named an allowed page.
    url:
      typeof url === "string" && isAllowedUrl(url)
        ? requireString(url, "Tab URL", MAX_URL_LENGTH)
        : BLANK_PAGE
  };
}

export interface TabIdPayload {
  readonly tabId: string;
}

export function parseTabIdPayload(raw: unknown): TabIdPayload {
  const root = requirePlainObject(raw, "Tab payload");
  return { tabId: requireIdentifier(root["tabId"], "Tab ID") };
}

export interface MoveTabPayload {
  readonly tabId: string;
  readonly paneId: BrowserPaneId;
}

export function parseMoveTabPayload(raw: unknown): MoveTabPayload {
  const root = requirePlainObject(raw, "Move tab payload");
  return {
    tabId: requireIdentifier(root["tabId"], "Tab ID"),
    paneId: requireOneOf(root["paneId"], PANE_IDS, "Pane")
  };
}

export function parseSplitPayload(raw: unknown): boolean {
  const root = requirePlainObject(raw, "Split payload");
  return requireBoolean(root["enabled"], "Split state");
}

export function parseActivePanePayload(raw: unknown): BrowserPaneId {
  const root = requirePlainObject(raw, "Active pane payload");
  return requireOneOf(root["paneId"], PANE_IDS, "Pane");
}

/** Re-exported so callers do not need to reach into the validation module. */
export { MAX_COLLECTION_LENGTH };
