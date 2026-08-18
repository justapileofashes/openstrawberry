/**
 * Owns the real Chromium views behind OpenStrawberry's tabs.
 *
 * Each tab is a sandboxed `WebContentsView` living in one app-owned persistent
 * session partition. The renderer reports where each pane sits on screen; this
 * process decides which views are attached and at what bounds. The renderer
 * never holds a handle to a view.
 *
 * `WebContentsView` is used rather than `BrowserView`, which Electron has
 * deprecated since version 29. The architecture is the same: native views owned
 * by the trusted process and composited over the chrome.
 *
 * Teardown is the subtlety here. A window can begin closing between any two
 * lifecycle events, so every detach is idempotent, guards against an
 * already-destroyed parent, and tolerates the underlying view having gone away.
 * Getting this wrong produces an "Object has been destroyed" dialog on exit.
 */
import { WebContentsView, type BrowserWindow, type Session } from "electron";
import { writeFileSync, readFileSync } from "node:fs";
import {
  PANE_IDS,
  parsePersistedSession,
  toPersistedSession,
  type BrowserPaneId,
  type BrowserSnapshot,
  type BrowserTabState,
  type BrowserViewport,
  MAX_TABS
} from "../shared/browser.js";
import { BLANK_PAGE } from "../shared/desktop-shell.js";
import {
  DEFAULT_SEARCH_TEMPLATE,
  displayHostname,
  isAllowedUrl,
  isSafeFaviconUrl,
  normalizeAddressInput,
  resolveSearchTemplate
} from "../shared/navigation.js";
import { conventionalFaviconUrl, FaviconResolver } from "./favicon.js";
import {
  MAX_TAB_GROUPS,
  nextColour,
  pruneEmptyGroups,
  type GroupColour,
  type TabGroup
} from "../shared/tab-groups.js";

interface TabRuntime {
  readonly view: WebContentsView;
  state: BrowserTabState;
}

interface PaneRuntime {
  activeTabId: string | null;
  viewport: BrowserViewport;
}

const ZERO_VIEWPORT: BrowserViewport = { x: 0, y: 0, width: 0, height: 0 };

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface BrowserManagerOptions {
  readonly window: BrowserWindow;
  readonly profile: Session;
  readonly sessionFilePath: string;
  readonly publish: (snapshot: BrowserSnapshot) => void;
}

export class BrowserManager {
  private readonly window: BrowserWindow;
  private readonly profile: Session;
  private readonly sessionFilePath: string;
  private readonly publish: (snapshot: BrowserSnapshot) => void;

  private readonly tabs = new Map<string, TabRuntime>();
  private readonly attachedTabIds = new Set<string>();
  private readonly panes: Record<BrowserPaneId, PaneRuntime> = {
    primary: { activeTabId: null, viewport: ZERO_VIEWPORT },
    secondary: { activeTabId: null, viewport: ZERO_VIEWPORT }
  };

  private readonly favicons: FaviconResolver;

  private activePaneId: BrowserPaneId = "primary";
  private splitEnabled = false;
  private nextTabSequence = 1;
  private nextGroupSequence = 1;
  private groups: readonly TabGroup[] = [];
  private destroyed = false;

  /**
   * Where a non-URL address goes.
   *
   * Always one of the templates shipped in `navigation.ts`. Migration can change
   * *which* one by name; it can never supply one.
   */
  private searchTemplate: string = DEFAULT_SEARCH_TEMPLATE;

  public constructor(options: BrowserManagerOptions) {
    this.window = options.window;
    this.profile = options.profile;
    this.sessionFilePath = options.sessionFilePath;
    this.publish = options.publish;
    this.favicons = new FaviconResolver(options.profile);
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Restores the previous session, or opens a single neutral tab.
   *
   * First launch and every empty restore land on `about:blank`, never a live
   * example domain.
   */
  public restore(): void {
    const session = parsePersistedSession(this.readSessionFile());

    // Persisted ids are reused so active-tab references stay meaningful. The
    // sequence counter is advanced past them so newly minted ids cannot collide.
    // Groups first, so a restored tab's membership resolves to a real group.
    this.groups = session.groups;
    for (const group of this.groups) {
      const suffix = Number.parseInt(group.id.replace(/^group-/u, ""), 10);
      if (Number.isInteger(suffix) && suffix >= this.nextGroupSequence) {
        this.nextGroupSequence = suffix + 1;
      }
    }

    for (const tab of session.tabs) {
      if (this.tabs.size >= MAX_TABS) break;
      this.createTabWithId(tab.id, tab.paneId, tab.url, false);

      const restored = this.tabs.get(tab.id);
      if (restored !== undefined && tab.groupId !== null) {
        restored.state = { ...restored.state, groupId: tab.groupId };
      }

      const suffix = Number.parseInt(tab.id.replace(/^tab-/u, ""), 10);
      if (Number.isInteger(suffix) && suffix >= this.nextTabSequence) {
        this.nextTabSequence = suffix + 1;
      }
    }

    for (const paneId of PANE_IDS) {
      const desired = session.activeTabByPane[paneId];
      if (desired !== null && this.tabs.has(desired)) {
        this.panes[paneId].activeTabId = desired;
      }
    }

    this.splitEnabled = session.splitEnabled;
    this.activePaneId = session.activePaneId;

    if (this.tabs.size === 0) this.createTab("primary", BLANK_PAGE, { activate: true });
    if (this.panes.primary.activeTabId === null) {
      const first = [...this.tabs.values()].find((tab) => tab.state.paneId === "primary");
      this.panes.primary.activeTabId = first?.state.id ?? null;
    }

    this.applyLayout();
    this.emit();
  }

  /**
   * Releases every native view.
   *
   * Called from the window's `close` event, before destruction, and again from
   * `closed` as a backstop. It must be safe to call twice and safe to call once
   * the parent window has already gone.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      this.persistSession();
    } catch {
      // A session that cannot be written must never block a clean exit.
    }

    for (const [tabId, tab] of this.tabs) this.destroyTabRuntime(tabId, tab);

    this.attachedTabIds.clear();
    this.tabs.clear();
  }

  /* --------------------------------------------------------------------- */
  /* Tabs                                                                  */
  /* --------------------------------------------------------------------- */

  public createTab(
    paneId: BrowserPaneId,
    url: string,
    options: { readonly activate: boolean } = { activate: true }
  ): BrowserSnapshot {
    return this.createTabWithId(`tab-${this.nextTabSequence++}`, paneId, url, options.activate);
  }

  private createTabWithId(
    id: string,
    paneId: BrowserPaneId,
    url: string,
    activate: boolean
  ): BrowserSnapshot {
    if (this.destroyed) return this.snapshot();
    if (this.tabs.size >= MAX_TABS) return this.snapshot();
    if (this.tabs.has(id)) return this.snapshot();

    const target = isAllowedUrl(url) ? url : BLANK_PAGE;

    const view = new WebContentsView({
      webPreferences: {
        // The app-owned persistent partition, passed as a live Session so the
        // permission handlers already installed on it apply to every guest.
        session: this.profile,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // Guest content gets no preload, so it has no OpenStrawberry surface
        // to reach for at all.
        webviewTag: false
      }
    });

    const runtime: TabRuntime = {
      view,
      state: {
        id,
        url: target,
        title: displayHostname(target),
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        isAudible: false,
        paneId,
        groupId: null
      }
    };

    this.tabs.set(id, runtime);
    this.observeTab(id, runtime);

    if (activate) {
      this.panes[paneId].activeTabId = id;
      this.activePaneId = paneId;
    } else if (this.panes[paneId].activeTabId === null) {
      this.panes[paneId].activeTabId = id;
    }

    this.loadUrl(id, target);
    this.applyLayout();
    return this.emit();
  }

  public closeTab(tabId: string): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.snapshot();

    const paneId = tab.state.paneId;
    this.destroyTabRuntime(tabId, tab);
    this.tabs.delete(tabId);
    // Closing the last member leaves a group nothing can reach again.
    this.pruneGroups();

    if (this.panes[paneId].activeTabId === tabId) {
      const next = [...this.tabs.values()].find((candidate) => candidate.state.paneId === paneId);
      this.panes[paneId].activeTabId = next?.state.id ?? null;
    }

    // The window must always own at least one tab so the chrome is never empty.
    if (this.tabs.size === 0) return this.createTab("primary", BLANK_PAGE, { activate: true });

    this.applyLayout();
    return this.emit();
  }

  public activateTab(tabId: string): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.snapshot();

    this.panes[tab.state.paneId].activeTabId = tabId;
    this.activePaneId = tab.state.paneId;

    this.applyLayout();
    return this.emit();
  }

  public moveTabToPane(tabId: string, paneId: BrowserPaneId): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.snapshot();

    const previousPane = tab.state.paneId;
    if (previousPane === paneId) return this.snapshot();

    tab.state = { ...tab.state, paneId };

    if (this.panes[previousPane].activeTabId === tabId) {
      const next = [...this.tabs.values()].find(
        (candidate) => candidate.state.paneId === previousPane
      );
      this.panes[previousPane].activeTabId = next?.state.id ?? null;
    }

    this.panes[paneId].activeTabId = tabId;
    // Dragging a tab into the second pane is how a split is created.
    if (paneId === "secondary") this.splitEnabled = true;

    this.applyLayout();
    return this.emit();
  }

  /* --------------------------------------------------------------------- */
  /* Navigation                                                            */
  /* --------------------------------------------------------------------- */

  public navigate(tabId: string, address: string): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.snapshot();

    // The template is whatever the user's imported engine resolved to, or the
    // shipped default. It is always one of this app's own addresses.
    const decision = normalizeAddressInput(address, this.searchTemplate);
    if (decision.kind === "rejected") return this.snapshot();

    this.loadUrl(tabId, decision.url);
    return this.snapshot();
  }

  public goBack(tabId: string): BrowserSnapshot {
    const contents = this.contentsFor(tabId);
    if (contents?.navigationHistory.canGoBack() === true) contents.navigationHistory.goBack();
    return this.snapshot();
  }

  public goForward(tabId: string): BrowserSnapshot {
    const contents = this.contentsFor(tabId);
    if (contents?.navigationHistory.canGoForward() === true) contents.navigationHistory.goForward();
    return this.snapshot();
  }

  public reload(tabId: string): BrowserSnapshot {
    this.contentsFor(tabId)?.reload();
    return this.snapshot();
  }

  public stop(tabId: string): BrowserSnapshot {
    this.contentsFor(tabId)?.stop();
    return this.snapshot();
  }

  /* --------------------------------------------------------------------- */
  /* Panes and layout                                                      */
  /* --------------------------------------------------------------------- */

  public setViewport(paneId: BrowserPaneId, viewport: BrowserViewport): BrowserSnapshot {
    this.panes[paneId].viewport = viewport;
    this.applyLayout();
    return this.snapshot();
  }

  public setSplitEnabled(enabled: boolean): BrowserSnapshot {
    this.splitEnabled = enabled;

    if (enabled && this.panes.secondary.activeTabId === null) {
      return this.createTab("secondary", BLANK_PAGE, { activate: false });
    }

    if (!enabled) this.activePaneId = "primary";

    this.applyLayout();
    return this.emit();
  }

  public setActivePane(paneId: BrowserPaneId): BrowserSnapshot {
    this.activePaneId = paneId;
    return this.emit();
  }

  public snapshot(): BrowserSnapshot {
    return {
      tabs: [...this.tabs.values()].map((tab) => tab.state),
      panes: PANE_IDS.map((id) => ({ id, activeTabId: this.panes[id].activeTabId })),
      activePaneId: this.activePaneId,
      splitEnabled: this.splitEnabled,
      groups: this.groups
    };
  }

  /* --------------------------------------------------------------------- */
  /* Groups                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * Creates a group holding one tab.
   *
   * A group is always born with a member, because an empty one has no rail
   * presence and would be immediately pruned. The colour cycles through the
   * palette so two groups made in a row look different without the user being
   * asked to choose.
   */
  public createGroup(tabId: string, name: string): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined || this.groups.length >= MAX_TAB_GROUPS) return this.snapshot();

    const group: TabGroup = {
      id: `group-${this.nextGroupSequence++}`,
      name,
      colour: nextColour(this.groups.length),
      collapsed: false
    };

    this.groups = [...this.groups, group];
    tab.state = { ...tab.state, groupId: group.id };

    return this.emit();
  }

  /** Renames, recolours, or collapses a group. Membership is untouched. */
  public updateGroup(
    groupId: string,
    name: string,
    colour: GroupColour,
    collapsed: boolean
  ): BrowserSnapshot {
    if (!this.groups.some((group) => group.id === groupId)) return this.snapshot();

    this.groups = this.groups.map((group) =>
      group.id === groupId ? { ...group, name, colour, collapsed } : group
    );

    return this.emit();
  }

  /**
   * Moves a tab into a group, or out of whichever one it was in.
   *
   * A group id that names nothing leaves the tab ungrouped rather than pointing
   * at something absent.
   */
  public assignTabToGroup(tabId: string, groupId: string | null): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return this.snapshot();

    const target =
      groupId !== null && this.groups.some((group) => group.id === groupId) ? groupId : null;

    tab.state = { ...tab.state, groupId: target };
    this.pruneGroups();

    return this.emit();
  }

  /**
   * Dissolves a group.
   *
   * Its tabs are released rather than closed. "Ungroup" is a statement about
   * organisation, and reading it as "close these" would destroy work.
   */
  public removeGroup(groupId: string): BrowserSnapshot {
    if (!this.groups.some((group) => group.id === groupId)) return this.snapshot();

    for (const tab of this.tabs.values()) {
      if (tab.state.groupId === groupId) tab.state = { ...tab.state, groupId: null };
    }

    this.groups = this.groups.filter((group) => group.id !== groupId);
    return this.emit();
  }

  /** Drops groups nothing belongs to, after a tab moved out or closed. */
  private pruneGroups(): void {
    this.groups = pruneEmptyGroups(
      this.groups,
      [...this.tabs.values()].map((tab) => tab.state.groupId)
    );
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  private emit(): BrowserSnapshot {
    const next = this.snapshot();
    if (!this.destroyed) this.publish(next);
    return next;
  }

  /**
   * The live contents behind a tab, or null once it has gone.
   *
   * Public so the agent runtime can read and drive a page through its own narrow
   * port. This is the only handle out of the tab engine, and it stays in the
   * trusted process: the renderer receives tab ids and never a view.
   */
  public contentsFor(tabId: string): Electron.WebContents | null {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return null;
    if (tab.view.webContents.isDestroyed()) return null;
    return tab.view.webContents;
  }

  /**
   * The tab a WebContents belongs to, with the page it is currently showing.
   *
   * Exists for the tracker blocker, which sees requests identified by
   * WebContents rather than by tab and has to know what page a request is being
   * made *from* before it can decide whether it is first-party.
   */
  public pageForWebContents(webContentsId: number): { tabId: string; url: string } | null {
    for (const [tabId, tab] of this.tabs) {
      if (tab.view.webContents.isDestroyed()) continue;
      if (tab.view.webContents.id !== webContentsId) continue;
      return { tabId, url: tab.state.url };
    }
    return null;
  }

  /**
   * Points searches at the engine a migration recorded.
   *
   * Takes the engine's *name*, not a URL, and resolves it against the shipped
   * table. An unrecognised name leaves the default in place, which is the right
   * outcome for an engine this browser has no template for.
   */
  public setSearchEngineName(name: string | null): void {
    this.searchTemplate = resolveSearchTemplate(name);
  }

  /** The tab the user is looking at, which is the one the chrome reports on. */
  public focusedTab(): { tabId: string; url: string } | null {
    const tabId = this.panes[this.activePaneId].activeTabId;
    if (tabId === null) return null;

    const tab = this.tabs.get(tabId);
    return tab === undefined ? null : { tabId, url: tab.state.url };
  }

  private loadUrl(tabId: string, url: string): void {
    const contents = this.contentsFor(tabId);
    if (contents === null) return;

    try {
      // A failed load is a normal browsing outcome, not an error to surface.
      void contents.loadURL(url).catch(() => this.refreshState(tabId));
    } catch {
      this.refreshState(tabId);
    }
  }

  private observeTab(tabId: string, tab: TabRuntime): void {
    const contents = tab.view.webContents;
    const refresh = (): void => this.refreshState(tabId);

    contents.on("did-start-loading", refresh);
    contents.on("did-stop-loading", refresh);
    contents.on("did-navigate", refresh);
    contents.on("did-navigate-in-page", refresh);
    contents.on("page-title-updated", refresh);
    contents.on("audio-state-changed", refresh);

    contents.on("page-favicon-updated", (_event, favicons) => {
      const declared = favicons.find((candidate) => isSafeFaviconUrl(candidate)) ?? null;
      if (declared !== null) void this.applyFavicon(tabId, declared);
    });

    // Many sites declare no icon but still serve the conventional path, which
    // is what a browser is expected to try.
    contents.on("did-finish-load", () => {
      const current = this.tabs.get(tabId);
      if (current === undefined || current.state.faviconUrl !== null) return;
      const fallback = conventionalFaviconUrl(current.state.url);
      if (fallback !== null) void this.applyFavicon(tabId, fallback);
    });

    // The navigation policy is enforced on the guest itself, not just at the
    // address bar, so a page cannot script its way to a disallowed scheme.
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedUrl(url)) event.preventDefault();
    });

    contents.on("will-redirect", (event, url) => {
      if (!isAllowedUrl(url)) event.preventDefault();
    });

    // Popups become real tabs when they are allowed, and are denied otherwise.
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) {
        const current = this.tabs.get(tabId);
        this.createTab(current?.state.paneId ?? "primary", url, { activate: true });
      }
      return { action: "deny" };
    });
  }

  /**
   * Inlines a resolved favicon into tab state.
   *
   * The tab is re-read after the await because it can be closed, or navigated
   * elsewhere, while the fetch is in flight.
   */
  private async applyFavicon(tabId: string, iconUrl: string): Promise<void> {
    const dataUrl = await this.favicons.resolve(iconUrl);
    if (dataUrl === null || this.destroyed) return;

    const current = this.tabs.get(tabId);
    if (current === undefined || current.state.faviconUrl === dataUrl) return;

    current.state = { ...current.state, faviconUrl: dataUrl };
    this.emit();
  }

  private refreshState(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;

    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;

    const url = contents.getURL() || tab.state.url;

    // A new site must not keep the previous site's mark, which would otherwise
    // let one origin appear to be another in the rail.
    const sameOrigin = originOf(url) === originOf(tab.state.url);

    tab.state = {
      ...tab.state,
      faviconUrl: sameOrigin ? tab.state.faviconUrl : null,
      url,
      title: contents.getTitle() || displayHostname(url),
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      isAudible: contents.isCurrentlyAudible()
    };

    this.emit();
  }

  /**
   * Attaches exactly the views that should be visible and detaches the rest.
   *
   * Inactive tabs stay alive but unattached, so switching back is instant while
   * only the visible views cost compositing.
   */
  private applyLayout(): void {
    if (this.destroyed || this.window.isDestroyed()) return;

    const visiblePanes: readonly BrowserPaneId[] = this.splitEnabled ? PANE_IDS : ["primary"];
    const visibleTabIds = new Set(
      visiblePanes
        .map((paneId) => this.panes[paneId].activeTabId)
        .filter((tabId): tabId is string => tabId !== null)
    );

    for (const tabId of [...this.attachedTabIds]) {
      if (visibleTabIds.has(tabId)) continue;
      this.detachTab(tabId);
    }

    for (const paneId of visiblePanes) {
      const tabId = this.panes[paneId].activeTabId;
      if (tabId === null) continue;

      const tab = this.tabs.get(tabId);
      if (tab === undefined || tab.view.webContents.isDestroyed()) continue;

      if (!this.attachedTabIds.has(tabId)) {
        try {
          this.window.contentView.addChildView(tab.view);
          this.attachedTabIds.add(tabId);
        } catch {
          continue;
        }
      }

      tab.view.setBounds(this.panes[paneId].viewport);
    }
  }

  /** Idempotent, and safe once the parent window has begun closing. */
  private detachTab(tabId: string): void {
    if (!this.attachedTabIds.has(tabId)) return;
    this.attachedTabIds.delete(tabId);

    if (this.window.isDestroyed()) return;

    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;

    try {
      this.window.contentView.removeChildView(tab.view);
    } catch {
      // The parent window can begin closing between lifecycle events.
    }
  }

  private destroyTabRuntime(tabId: string, tab: TabRuntime): void {
    this.detachTab(tabId);

    try {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    } catch {
      // The view may already have been torn down with the window.
    }
  }

  private readSessionFile(): unknown {
    try {
      // Strip a byte-order mark. OpenStrawberry never writes one, but an editor
      // or sync tool touching the file would otherwise silently discard the
      // whole session.
      const text = readFileSync(this.sessionFilePath, "utf8").replace(/^﻿/u, "");
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private persistSession(): void {
    const session = toPersistedSession(this.snapshot());
    writeFileSync(this.sessionFilePath, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
  }
}
