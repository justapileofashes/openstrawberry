/* OpenStrawberry runtime: real Chromium tabs stay isolated from the Liquid Glass browser chrome. */
import { BrowserView, BrowserWindow, session, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PANE_IDS, validateTabGroupName, validateWorkspaceName, type BrowserCommand, type BrowserDownloadState, type BrowserPaneId, type BrowserSnapshot, type BrowserTabGroup, type BrowserTabState, type BrowserViewport, type TabGroupColor, type WorkspaceSnapshot } from "../shared/browser.js";
import { isBrowserUrlAllowed, normalizeBrowserUrl } from "../shared/navigation.js";
import { EMPTY_MEDIA_STATE, type MediaCommand, type MediaState } from "../shared/media.js";
import { normalizePrivacyHost, shouldBlockTrackerRequest, type PrivacyState } from "../shared/privacy.js";
import { buildReaderModeScript } from "../shared/reader.js";

type TabRuntime = { view: BrowserView; state: BrowserTabState };
type SavedSession = { version: 1 | 2 | 3; tabs: { id: string; url: string; groupId?: string }[]; groups?: BrowserTabGroup[]; privacy?: { trackerBlockingEnabled?: boolean; allowedHosts?: string[] }; panes: { id: BrowserPaneId; tabId: string | null }[]; activePaneId: BrowserPaneId; splitEnabled: boolean };
const FALLBACK_TITLE = "New tab";
const PROFILE_PARTITION = "persist:openstrawberry-default";

export class BrowserManager {
  private readonly tabs = new Map<string, TabRuntime>();
  private readonly groups = new Map<string, BrowserTabGroup>();
  private readonly profile = session.fromPartition(PROFILE_PARTITION);
  private readonly allowedTrackerHosts = new Set<string>();
  private readonly blockedRequestsByTab = new Map<string, number>();
  private readonly panes: Record<BrowserPaneId, { tabId: string | null; viewport: BrowserViewport }> = {
    primary: { tabId: null, viewport: { paneId: "primary", x: 0, y: 0, width: 0, height: 0 } },
    secondary: { tabId: null, viewport: { paneId: "secondary", x: 0, y: 0, width: 0, height: 0 } }
  };
  private readonly downloads: BrowserDownloadState[] = [];
  private readonly downloadPaths = new Map<string, string>();
  private readonly attachedTabIds = new Set<string>();
  private activePaneId: BrowserPaneId = "primary";
  private splitEnabled = false;
  private trackerBlockingEnabled = true;
  private initialized = false;
  public constructor(private readonly window: BrowserWindow, private readonly emit: (snapshot: BrowserSnapshot) => void, private readonly sessionFile: string, private readonly workspaceFile: string) {
    this.profile.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.profile.setPermissionCheckHandler(() => false);
    this.profile.on("will-download", (_event, item) => this.trackDownload(item));
    this.profile.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const cancel = shouldBlockTrackerRequest({ url: details.url, referrer: details.referrer, resourceType: details.resourceType, enabled: this.trackerBlockingEnabled, allowedHosts: [...this.allowedTrackerHosts] });
      if (cancel) {
        const tabId = this.tabIdForWebContentsId(details.webContentsId);
        if (tabId) {
          this.blockedRequestsByTab.set(tabId, Math.min(10_000, (this.blockedRequestsByTab.get(tabId) ?? 0) + 1));
          this.emit(this.snapshot());
        }
      }
      callback({ cancel });
    });
  }

  public initialize(): BrowserSnapshot {
    if (this.initialized) return this.snapshot();
    this.initialized = true;
    const saved = this.readSession();
    if (saved) {
      this.hydratePrivacy(saved.privacy);
      for (const tab of saved.tabs) this.createTab(tab.url, "primary", tab.id, false);
      this.hydrateGroups(saved.groups ?? []);
      for (const pane of saved.panes) if (pane.tabId && this.tabs.has(pane.tabId)) this.assignTabToPane(pane.tabId, pane.id);
      this.activePaneId = saved.activePaneId;
      this.splitEnabled = saved.splitEnabled && Boolean(this.panes.secondary.tabId);
    }
    if (!this.panes.primary.tabId) this.createTab("https://example.com", "primary", undefined, false);
    this.attachVisibleViews();
    this.publish();
    return this.snapshot();
  }

  public createTab(input: unknown = "https://example.com", paneId = this.activePaneId, suppliedId?: string, publish = true): BrowserSnapshot {
    const id = suppliedId ?? randomUUID();
    const view = new BrowserView({ webPreferences: { partition: PROFILE_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    const runtime: TabRuntime = { view, state: { id, url: "", title: FALLBACK_TITLE, favicon: null, isLoading: true, canGoBack: false, canGoForward: false, isAudible: false } };
    this.tabs.set(id, runtime);
    this.observeTab(id, runtime);
    view.webContents.setWindowOpenHandler(({ url }) => { if (isBrowserUrlAllowed(url)) this.createTab(url, paneId); return { action: "deny" }; });
    view.webContents.on("will-navigate", (event, url) => { if (!this.isAllowedNavigation(url)) event.preventDefault(); });
    this.loadSafeUrl(id, input);
    this.assignTabToPane(id, paneId);
    this.activePaneId = paneId;
    if (paneId === "secondary") this.splitEnabled = true;
    if (publish) this.publish();
    return this.snapshot();
  }

  public activateTab(id: string, paneId = this.activePaneId): BrowserSnapshot {
    if (!this.tabs.has(id)) return this.snapshot();
    this.assignTabToPane(id, paneId);
    this.activePaneId = paneId;
    if (paneId === "secondary") this.splitEnabled = true;
    this.publish();
    return this.snapshot();
  }
  public closeTab(id: string): BrowserSnapshot {
    const runtime = this.tabs.get(id); if (!runtime) return this.snapshot();
    this.window.removeBrowserView(runtime.view); this.attachedTabIds.delete(id); runtime.view.webContents.close(); this.tabs.delete(id);
    this.blockedRequestsByTab.delete(id);
    this.removeTabFromGroups(id);
    for (const paneId of PANE_IDS) if (this.panes[paneId].tabId === id) this.panes[paneId].tabId = this.tabs.keys().next().value ?? null;
    if (!this.panes.primary.tabId) return this.createTab();
    if (!this.panes.secondary.tabId) this.splitEnabled = false;
    this.publish();
    return this.snapshot();
  }
  public navigate(id: string, input: unknown): BrowserSnapshot { const tab = this.tabs.get(id); if (tab) this.loadSafeUrl(id, input); return this.snapshot(); }
  public command(id: string, command: BrowserCommand): BrowserSnapshot {
    const tab = this.tabs.get(id); if (!tab) return this.snapshot(); const wc = tab.view.webContents;
    if (command === "back" && wc.canGoBack()) wc.goBack(); if (command === "forward" && wc.canGoForward()) wc.goForward(); if (command === "reload") wc.reload(); if (command === "stop") wc.stop();
    this.updateState(id); return this.snapshot();
  }
  public setViewport(viewport: BrowserViewport): BrowserSnapshot {
    this.panes[viewport.paneId].viewport = { paneId: viewport.paneId, x: Math.max(0, Math.round(viewport.x)), y: Math.max(0, Math.round(viewport.y)), width: Math.max(0, Math.round(viewport.width)), height: Math.max(0, Math.round(viewport.height)) };
    this.attachVisibleViews();
    return this.snapshot();
  }
  public setSplit(enabled: boolean): BrowserSnapshot {
    if (enabled && !this.panes.secondary.tabId) {
      const alternative = [...this.tabs.keys()].find((id) => id !== this.panes.primary.tabId);
      if (alternative) this.panes.secondary.tabId = alternative;
      else this.createTab("https://example.com", "secondary", undefined, false);
    }
    this.splitEnabled = enabled;
    this.publish();
    return this.snapshot();
  }
  public setActivePane(paneId: BrowserPaneId): BrowserSnapshot { this.activePaneId = paneId; this.publish(); return this.snapshot(); }
  public createTabGroup(name: string, color: TabGroupColor, tabIds: string[]): BrowserSnapshot {
    const included = [...new Set(tabIds)].filter((id) => this.tabs.has(id)).slice(0, 50);
    if (!included.length) throw new Error("Select at least one open tab to create a group.");
    const group: BrowserTabGroup = { id: randomUUID(), name: validateTabGroupName(name), color, collapsed: false, tabIds: included };
    for (const tabId of included) { this.removeTabFromGroups(tabId); const tab = this.tabs.get(tabId); if (tab) tab.state.groupId = group.id; }
    this.groups.set(group.id, group);
    this.publish();
    return this.snapshot();
  }
  public assignTabToGroup(tabId: string, groupId?: string): BrowserSnapshot {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error("That tab is no longer open.");
    this.removeTabFromGroups(tabId);
    if (groupId) {
      const group = this.groups.get(groupId);
      if (!group) throw new Error("That tab group no longer exists.");
      group.tabIds.push(tabId);
      tab.state.groupId = groupId;
    }
    this.publish();
    return this.snapshot();
  }
  public toggleTabGroup(groupId: string): BrowserSnapshot {
    const group = this.groups.get(groupId);
    if (!group) throw new Error("That tab group no longer exists.");
    group.collapsed = !group.collapsed;
    if (group.collapsed && group.tabIds.includes(this.panes[this.activePaneId].tabId ?? "")) {
      const fallback = [...this.tabs.values()].find((tab) => tab.state.groupId !== group.id)?.state.id;
      if (fallback) this.assignTabToPane(fallback, this.activePaneId);
    }
    this.publish();
    return this.snapshot();
  }
  public deleteTabGroup(groupId: string): BrowserSnapshot {
    const group = this.groups.get(groupId);
    if (!group) return this.snapshot();
    for (const tabId of group.tabIds) { const tab = this.tabs.get(tabId); if (tab) delete tab.state.groupId; }
    this.groups.delete(groupId);
    this.publish();
    return this.snapshot();
  }
  public setTrackerBlocking(enabled: boolean): BrowserSnapshot { this.trackerBlockingEnabled = enabled; this.publish(); return this.snapshot(); }
  public toggleTrackerBlockingForActiveSite(): BrowserSnapshot {
    const activeId = this.panes[this.activePaneId].tabId;
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (!active?.state.url) throw new Error("Open an http(s) page before changing its tracker-blocking exception.");
    const host = normalizePrivacyHost(active.state.url);
    if (this.allowedTrackerHosts.has(host)) this.allowedTrackerHosts.delete(host); else this.allowedTrackerHosts.add(host);
    this.publish();
    return this.snapshot();
  }
  public async mediaState(): Promise<MediaState> { return this.executeMediaCommand({ action: "refresh" }); }
  public async mediaCommand(command: MediaCommand): Promise<MediaState> { return this.executeMediaCommand(command); }
  public async toggleReaderMode(): Promise<boolean> {
    const activeId = this.panes[this.activePaneId].tabId;
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (!active || active.view.webContents.isDestroyed()) return false;
    try { return Boolean(await active.view.webContents.executeJavaScript(buildReaderModeScript(), true)); } catch { return false; }
  }
  public snapshot(): BrowserSnapshot { return { activeTabId: this.panes[this.activePaneId].tabId, activePaneId: this.activePaneId, splitEnabled: this.splitEnabled, panes: PANE_IDS.map((id) => ({ id, tabId: this.panes[id].tabId })), tabs: [...this.tabs.values()].map((tab) => tab.state), groups: [...this.groups.values()].map((group) => ({ ...group, tabIds: [...group.tabIds] })), downloads: this.downloads, privacy: this.privacyState() }; }
  public selectedContextUrls(): string[] { return PANE_IDS.map((paneId) => this.panes[paneId].tabId).filter((id): id is string => Boolean(id)).map((id) => this.tabs.get(id)?.state.url ?? "").filter((url) => Boolean(url)); }
  public revealDownload(id: string): boolean {
    const record = this.downloads.find((download) => download.id === id);
    const filePath = this.downloadPaths.get(id);
    if (!record || record.state !== "completed" || !filePath) return false;
    shell.showItemInFolder(filePath);
    return true;
  }
  public listWorkspaceSnapshots(): WorkspaceSnapshot[] { return this.readWorkspaceSnapshots().sort((left, right) => right.createdAt - left.createdAt); }
  public saveWorkspaceSnapshot(name: string): WorkspaceSnapshot {
    const snapshot: WorkspaceSnapshot = { id: randomUUID(), name: validateWorkspaceName(name), createdAt: Date.now(), tabs: [...this.tabs.values()].map((tab) => ({ id: tab.state.id, url: tab.state.url || "https://example.com", ...(tab.state.groupId ? { groupId: tab.state.groupId } : {}) })), groups: [...this.groups.values()].map((group) => ({ ...group, tabIds: [...group.tabIds] })), panes: PANE_IDS.map((id) => ({ id, tabId: this.panes[id].tabId })), activePaneId: this.activePaneId, splitEnabled: this.splitEnabled };
    this.writeWorkspaceSnapshots([snapshot, ...this.readWorkspaceSnapshots()].slice(0, 50));
    return snapshot;
  }
  public restoreWorkspaceSnapshot(id: string): BrowserSnapshot {
    const saved = this.readWorkspaceSnapshots().find((candidate) => candidate.id === id);
    if (!saved) throw new Error("That workspace snapshot no longer exists.");
    for (const tab of this.tabs.values()) { this.window.removeBrowserView(tab.view); if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); }
    this.tabs.clear();
    this.groups.clear();
    for (const paneId of PANE_IDS) this.panes[paneId].tabId = null;
    for (const tab of saved.tabs.slice(0, 50)) this.createTab(tab.url, "primary", tab.id, false);
    this.hydrateGroups(Array.isArray(saved.groups) ? saved.groups : []);
    for (const pane of saved.panes) if (pane.tabId && this.tabs.has(pane.tabId)) this.assignTabToPane(pane.tabId, pane.id);
    if (!this.panes.primary.tabId) this.createTab("https://example.com", "primary", undefined, false);
    this.activePaneId = saved.activePaneId;
    this.splitEnabled = saved.splitEnabled && Boolean(this.panes.secondary.tabId);
    this.publish();
    return this.snapshot();
  }
  public destroy(): void { for (const tab of this.tabs.values()) { this.window.removeBrowserView(tab.view); if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } this.attachedTabIds.clear(); this.tabs.clear(); this.groups.clear(); }
  private observeTab(id: string, tab: TabRuntime): void {
    const refresh = () => this.updateState(id); const wc = tab.view.webContents;
    wc.on("did-start-loading", refresh); wc.on("did-stop-loading", refresh); wc.on("did-navigate", refresh); wc.on("did-navigate-in-page", refresh); wc.on("page-title-updated", refresh);
    wc.on("focus", () => { const paneId = PANE_IDS.find((candidate) => this.panes[candidate].tabId === id); if (paneId && this.activePaneId !== paneId) { this.activePaneId = paneId; this.emit(this.snapshot()); } });
    wc.on("page-favicon-updated", (_event, favicons) => { tab.state.favicon = favicons[0] ?? null; this.publish(); });
    wc.on("media-started-playing", () => { tab.state.isAudible = true; this.publish(); }); wc.on("media-paused", () => { tab.state.isAudible = false; this.publish(); });
  }
  private updateState(id: string): void { const tab = this.tabs.get(id); if (!tab || tab.view.webContents.isDestroyed()) return; const wc = tab.view.webContents; tab.state = { ...tab.state, url: wc.getURL(), title: wc.getTitle() || FALLBACK_TITLE, isLoading: wc.isLoading(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }; this.publish(); }
  private loadSafeUrl(id: string, input: unknown): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    try { void tab.view.webContents.loadURL(normalizeBrowserUrl(input)).catch(() => this.updateState(id)); } catch { this.updateState(id); }
  }
  private attachVisibleViews(): void {
    const visible = this.splitEnabled ? PANE_IDS : ["primary"] as BrowserPaneId[];
    const visibleTabIds = new Set(visible.map((paneId) => this.panes[paneId].tabId).filter((tabId): tabId is string => Boolean(tabId)));
    for (const tabId of this.attachedTabIds) {
      if (visibleTabIds.has(tabId)) continue;
      const tab = this.tabs.get(tabId);
      if (tab) this.window.removeBrowserView(tab.view);
      this.attachedTabIds.delete(tabId);
    }
    for (const paneId of visible) {
      const tabId = this.panes[paneId].tabId;
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (!tab || !tabId) continue;
      if (!this.attachedTabIds.has(tabId)) { this.window.addBrowserView(tab.view); this.attachedTabIds.add(tabId); }
      tab.view.setBounds(this.panes[paneId].viewport);
    }
  }
  private assignTabToPane(tabId: string, paneId: BrowserPaneId): void {
    for (const candidate of PANE_IDS) if (candidate !== paneId && this.panes[candidate].tabId === tabId) this.panes[candidate].tabId = null;
    this.panes[paneId].tabId = tabId;
  }
  private removeTabFromGroups(tabId: string): void {
    for (const group of this.groups.values()) {
      const index = group.tabIds.indexOf(tabId);
      if (index >= 0) group.tabIds.splice(index, 1);
      if (group.tabIds.length === 0) this.groups.delete(group.id);
    }
    const tab = this.tabs.get(tabId);
    if (tab) delete tab.state.groupId;
  }
  private hydrateGroups(savedGroups: BrowserTabGroup[]): void {
    this.groups.clear();
    const colors: readonly TabGroupColor[] = ["slate", "blue", "violet", "rose", "amber", "emerald"];
    for (const candidate of savedGroups.slice(0, 25)) {
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.collapsed !== "boolean" || !Array.isArray(candidate.tabIds)) continue;
      const tabIds = [...new Set(candidate.tabIds)].filter((tabId) => this.tabs.has(tabId)).slice(0, 50);
      if (!tabIds.length) continue;
      const color: TabGroupColor = colors.includes(candidate.color) ? candidate.color : "slate";
      const group: BrowserTabGroup = { id: candidate.id, name: candidate.name.slice(0, 40), color, collapsed: candidate.collapsed, tabIds };
      this.groups.set(group.id, group);
      for (const tabId of tabIds) { const tab = this.tabs.get(tabId); if (tab) tab.state.groupId = group.id; }
    }
  }
  private tabIdForWebContentsId(webContentsId: number | undefined): string | undefined {
    if (typeof webContentsId !== "number") return undefined;
    return [...this.tabs.entries()].find(([, tab]) => tab.view.webContents.id === webContentsId)?.[0];
  }
  private privacyState(): PrivacyState {
    const activeId = this.panes[this.activePaneId].tabId;
    const active = activeId ? this.tabs.get(activeId) : undefined;
    const activeUrl = active?.state.url;
    let activeSiteException = false;
    try { activeSiteException = Boolean(activeUrl) && this.allowedTrackerHosts.has(normalizePrivacyHost(activeUrl)); } catch { /* Non-web pages have no exception control. */ }
    return { trackerBlockingEnabled: this.trackerBlockingEnabled, activeSiteException, activeTabBlockedRequests: Math.min(10_000, activeId ? this.blockedRequestsByTab.get(activeId) ?? 0 : 0) };
  }
  private hydratePrivacy(saved: SavedSession["privacy"]): void {
    this.trackerBlockingEnabled = saved?.trackerBlockingEnabled !== false;
    this.allowedTrackerHosts.clear();
    for (const candidate of saved?.allowedHosts ?? []) { try { this.allowedTrackerHosts.add(normalizePrivacyHost(`https://${candidate}`)); } catch { /* Ignore malformed old local preference values. */ } }
  }
  private publish(): void { this.attachVisibleViews(); this.writeSession(); this.emit(this.snapshot()); }
  private readSession(): SavedSession | null {
    try { if (!existsSync(this.sessionFile)) return null; const parsed = JSON.parse(readFileSync(this.sessionFile, "utf8")) as SavedSession; return (parsed.version === 1 || parsed.version === 2 || parsed.version === 3) && Array.isArray(parsed.tabs) && Array.isArray(parsed.panes) ? parsed : null; } catch { return null; }
  }
  private writeSession(): void {
    try { mkdirSync(dirname(this.sessionFile), { recursive: true }); const payload: SavedSession = { version: 3, tabs: [...this.tabs.values()].map((tab) => ({ id: tab.state.id, url: tab.state.url || "https://example.com", ...(tab.state.groupId ? { groupId: tab.state.groupId } : {}) })), groups: [...this.groups.values()].map((group) => ({ ...group, tabIds: [...group.tabIds] })), privacy: { trackerBlockingEnabled: this.trackerBlockingEnabled, allowedHosts: [...this.allowedTrackerHosts].sort() }, panes: PANE_IDS.map((id) => ({ id, tabId: this.panes[id].tabId })), activePaneId: this.activePaneId, splitEnabled: this.splitEnabled }; writeFileSync(this.sessionFile, JSON.stringify(payload, null, 2), "utf8"); } catch { /* Session restore is best-effort and never blocks browsing. */ }
  }
  private readWorkspaceSnapshots(): WorkspaceSnapshot[] {
    try { if (!existsSync(this.workspaceFile)) return []; const parsed = JSON.parse(readFileSync(this.workspaceFile, "utf8")) as WorkspaceSnapshot[]; return Array.isArray(parsed) ? parsed.filter((snapshot) => typeof snapshot?.id === "string" && typeof snapshot?.name === "string" && Array.isArray(snapshot?.tabs) && Array.isArray(snapshot?.panes)) : []; } catch { return []; }
  }
  private writeWorkspaceSnapshots(snapshots: WorkspaceSnapshot[]): void {
    try { mkdirSync(dirname(this.workspaceFile), { recursive: true }); writeFileSync(this.workspaceFile, JSON.stringify(snapshots, null, 2), "utf8"); } catch { /* Workspace save is local best-effort and never blocks browsing. */ }
  }
  private trackDownload(item: Electron.DownloadItem): void {
    const record: BrowserDownloadState = { id: randomUUID(), filename: item.getFilename(), receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state: "progressing" };
    this.downloadPaths.set(record.id, item.getSavePath());
    this.downloads.unshift(record);
    item.on("updated", () => { record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); this.emit(this.snapshot()); });
    item.once("done", (_event, state) => { record.state = state === "completed" ? "completed" : "cancelled"; this.emit(this.snapshot()); });
    this.emit(this.snapshot());
  }
  private async executeMediaCommand(command: MediaCommand): Promise<MediaState> {
    const activeId = this.panes[this.activePaneId].tabId;
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (!active || active.view.webContents.isDestroyed()) return EMPTY_MEDIA_STATE;
    const value = "value" in command && typeof command.value === "number" && Number.isFinite(command.value) ? command.value : null;
    const action = command.action;
    const script = `(() => {
      const videos = Array.from(document.querySelectorAll("video"));
      const video = videos.find((candidate) => !candidate.paused || candidate.currentTime > 0) || videos[0];
      const snapshot = (message) => !video ? ({ available: false, pictureInPictureSupported: false, isPlaying: false, currentTime: 0, duration: 0, volume: 1, muted: false, title: document.title || "No active media", message: message || "No HTML video element was found in this tab." }) : ({ available: true, pictureInPictureSupported: Boolean(video.requestPictureInPicture && document.pictureInPictureEnabled), isPlaying: !video.paused, currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0, duration: Number.isFinite(video.duration) ? video.duration : 0, volume: video.volume, muted: video.muted, title: document.title || "Active media", message });
      if (!video) return snapshot();
      try {
        const action = ${JSON.stringify(action)};
        const value = ${JSON.stringify(value)};
        if (action === "play") { void video.play(); }
        if (action === "pause") { video.pause(); }
        if (action === "toggle") { if (video.paused) { void video.play(); } else { video.pause(); } }
        if (action === "seek" && typeof value === "number") { video.currentTime = Math.max(0, Math.min(value, Number.isFinite(video.duration) ? video.duration : value)); }
        if (action === "volume" && typeof value === "number") { video.volume = Math.max(0, Math.min(value, 1)); video.muted = false; }
        if (action === "mute") { video.muted = !video.muted; }
        if (action === "picture-in-picture") {
          if (!video.requestPictureInPicture || !document.pictureInPictureEnabled) return snapshot("This site does not expose browser-native picture-in-picture for the selected video.");
          if (document.pictureInPictureElement === video) { void document.exitPictureInPicture(); } else { void video.requestPictureInPicture(); }
        }
        return snapshot();
      } catch (error) { return snapshot(error instanceof Error ? error.message : "The media control request could not be completed."); }
    })()`;
    try {
      const state = await active.view.webContents.executeJavaScript(script, true) as MediaState;
      return state && typeof state.available === "boolean" ? state : EMPTY_MEDIA_STATE;
    } catch {
      return { ...EMPTY_MEDIA_STATE, title: active.state.title, message: "The page did not allow media inspection at this moment." };
    }
  }
  private isAllowedNavigation(url: string): boolean { return isBrowserUrlAllowed(url); }
}
