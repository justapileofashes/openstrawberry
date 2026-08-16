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
  displayHostname,
  isAllowedUrl,
  isSafeFaviconUrl,
  normalizeAddressInput
} from "../shared/navigation.js";

interface TabRuntime {
  readonly view: WebContentsView;
  state: BrowserTabState;
}

interface PaneRuntime {
  activeTabId: string | null;
  viewport: BrowserViewport;
}

const ZERO_VIEWPORT: BrowserViewport = { x: 0, y: 0, width: 0, height: 0 };

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

  private activePaneId: BrowserPaneId = "primary";
  private splitEnabled = false;
  private nextTabSequence = 1;
  private destroyed = false;

  public constructor(options: BrowserManagerOptions) {
    this.window = options.window;
    this.profile = options.profile;
    this.sessionFilePath = options.sessionFilePath;
    this.publish = options.publish;
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
    for (const tab of session.tabs) {
      if (this.tabs.size >= MAX_TABS) break;
      this.createTabWithId(tab.id, tab.paneId, tab.url, false);

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
        paneId
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

    const decision = normalizeAddressInput(address);
    if (decision.kind === "rejected") return this.snapshot();

    this.loadUrl(tabId, decision.url);
    return this.snapshot();
  }

  public goBack(tabId: string): BrowserSnapshot {
    const contents = this.liveContents(tabId);
    if (contents?.navigationHistory.canGoBack() === true) contents.navigationHistory.goBack();
    return this.snapshot();
  }

  public goForward(tabId: string): BrowserSnapshot {
    const contents = this.liveContents(tabId);
    if (contents?.navigationHistory.canGoForward() === true) contents.navigationHistory.goForward();
    return this.snapshot();
  }

  public reload(tabId: string): BrowserSnapshot {
    this.liveContents(tabId)?.reload();
    return this.snapshot();
  }

  public stop(tabId: string): BrowserSnapshot {
    this.liveContents(tabId)?.stop();
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
      splitEnabled: this.splitEnabled
    };
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  private emit(): BrowserSnapshot {
    const next = this.snapshot();
    if (!this.destroyed) this.publish(next);
    return next;
  }

  private liveContents(tabId: string): Electron.WebContents | null {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return null;
    if (tab.view.webContents.isDestroyed()) return null;
    return tab.view.webContents;
  }

  private loadUrl(tabId: string, url: string): void {
    const contents = this.liveContents(tabId);
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
      const safe = favicons.find((candidate) => isSafeFaviconUrl(candidate)) ?? null;
      const current = this.tabs.get(tabId);
      if (current === undefined) return;
      current.state = { ...current.state, faviconUrl: safe };
      this.emit();
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

  private refreshState(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;

    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;

    const url = contents.getURL() || tab.state.url;

    tab.state = {
      ...tab.state,
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
