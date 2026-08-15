/* OpenStrawberry desktop shell: monochrome technical chrome with Liquid Glass reserved for Companion and control surfaces. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, CircleStop, Columns2, Command, Download, Globe2, LayoutPanelTop, Maximize2, MoreHorizontal, PanelRightClose, Pause, Play, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import { TAB_GROUP_COLORS, type BrowserPaneId, type BrowserSnapshot, type BrowserTabGroup, type BrowserTabState, type TabGroupColor, type WorkspaceSnapshot } from "../shared/browser";
import { defaultAgentProfiles, type AgentProfileInput, type AgentProfileSummary, type LocalCliStatus } from "../shared/agent";
import { EMPTY_MEDIA_STATE, type MediaCommand, type MediaState } from "../shared/media";
import type { OrchestrationPlan } from "../shared/orchestration";
import type { AgentRunResult } from "../shared/agent-run";
import type { BookmarkExportPreview, BrowserId, BrowserMigrationCandidate, OnboardingState, PasswordExportPreview } from "../shared/migration";
import { resolveBrowserShortcut } from "../shared/keyboard";
import { downloadProgress } from "../shared/download";

const EMPTY_SNAPSHOT: BrowserSnapshot = { activeTabId: null, activePaneId: "primary", splitEnabled: false, panes: [{ id: "primary", tabId: null }, { id: "secondary", tabId: null }], tabs: [], groups: [], downloads: [], privacy: { trackerBlockingEnabled: true, activeSiteException: false, activeTabBlockedRequests: 0 } };
const PALETTE_ACTIONS = [{ id: "new-tab", label: "New tab", hint: "⌘/Ctrl T" }, { id: "focus-address", label: "Focus address bar", hint: "⌘/Ctrl L" }, { id: "toggle-split", label: "Toggle split workspace", hint: "⌘/Ctrl Shift S" }, { id: "reader-mode", label: "Toggle reader mode", hint: "" }, { id: "open-workspaces", label: "Open saved workspaces", hint: "" }, { id: "toggle-agents", label: "Toggle Companion", hint: "" }];
const GROUP_COLORS: Record<TabGroupColor, string> = { slate: "#899198", blue: "#6aa5ff", violet: "#b18cff", rose: "#ff8aab", amber: "#f9c86c", emerald: "#6ad7ac" };

function IconButton({ label, disabled, children, onClick }: { label: string; disabled?: boolean; children: ReactNode; onClick?: () => void }) {
  return <button aria-label={label} disabled={disabled} onClick={onClick} className="icon-button">{children}</button>;
}

export function App() {
  const [browser, setBrowser] = useState<BrowserSnapshot>(EMPTY_SNAPSHOT);
  const [urlInput, setUrlInput] = useState("");
  const [agentRailOpen, setAgentRailOpen] = useState(true);
  const [agentView, setAgentView] = useState<"agents" | "orchestrate" | "runs">("agents");
  const [agents, setAgents] = useState<AgentProfileSummary[]>(defaultAgentProfiles);
  const [localClis, setLocalClis] = useState<LocalCliStatus[]>([]);
  const [orchestrationPlan, setOrchestrationPlan] = useState<OrchestrationPlan | null>(null);
  const [media, setMedia] = useState<MediaState>(EMPTY_MEDIA_STATE);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [migrationCandidates, setMigrationCandidates] = useState<BrowserMigrationCandidate[]>([]);
  const [migrationStatus, setMigrationStatus] = useState("");
  const [passwordExportPreview, setPasswordExportPreview] = useState<PasswordExportPreview | null>(null);
  const [bookmarkExportPreview, setBookmarkExportPreview] = useState<BookmarkExportPreview | null>(null);
  const [workspaceDrawerOpen, setWorkspaceDrawerOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaces, setWorkspaces] = useState<WorkspaceSnapshot[]>([]);
  const [workspaceStatus, setWorkspaceStatus] = useState("");
  const [groupName, setGroupName] = useState("Focus");
  const [groupColor, setGroupColor] = useState<TabGroupColor>("violet");
  const [groupStatus, setGroupStatus] = useState("");
  const [privacyStatus, setPrivacyStatus] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [downloadDrawerOpen, setDownloadDrawerOpen] = useState(false);
  const primaryViewportRef = useRef<HTMLDivElement>(null);
  const secondaryViewportRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const activeTab = browser.tabs.find((tab) => tab.id === browser.activeTabId) ?? null;
  const visibleTabs = browser.tabs.filter((tab) => !tab.groupId || !browser.groups.find((group) => group.id === tab.groupId)?.collapsed);
  const activeSiteIsWeb = Boolean(activeTab?.url && /^https?:\/\//i.test(activeTab.url));
  const refreshMedia = useCallback(() => { void window.openStrawberry.media.state().then((state) => { if (state) setMedia(state); }); }, []);

  useEffect(() => {
    const update = (snapshot: BrowserSnapshot) => setBrowser(snapshot);
    void window.openStrawberry.browser.ready().then((snapshot) => {
      if (snapshot && snapshot.tabs.length > 0) update(snapshot);
      else void window.openStrawberry.browser.create("https://example.com");
    });
    return window.openStrawberry.browser.onState(update);
  }, []);

  useEffect(() => {
    void window.openStrawberry.agents.list().then(setAgents);
    void window.openStrawberry.agents.detectLocalClis().then(setLocalClis);
  }, []);

  useEffect(() => {
    void Promise.all([window.openStrawberry.migration.state(), window.openStrawberry.migration.detect()]).then(([state, candidates]) => { setOnboarding(state); setMigrationCandidates(candidates); });
  }, []);

  useEffect(() => { void window.openStrawberry.workspaces.list().then(setWorkspaces); }, []);

  const completeFreshProfile = () => { void window.openStrawberry.migration.complete().then(setOnboarding); };
  const importMigration = (browserId: BrowserId) => {
    setMigrationStatus("Waiting for native approval…");
    void window.openStrawberry.migration.importBrowser(browserId).then((result) => window.openStrawberry.migration.complete(result.browser).then((state) => { setMigrationStatus(""); setOnboarding(state); })).catch((error: unknown) => setMigrationStatus(error instanceof Error ? error.message : "The selected browser could not be migrated."));
  };
  const selectPasswordExport = (browserId: BrowserId) => {
    setMigrationStatus("Choose a browser-generated password CSV in the native file picker…");
    void window.openStrawberry.migration.selectPasswordExport(browserId).then((preview) => { setMigrationStatus(""); setPasswordExportPreview(preview); }).catch((error: unknown) => setMigrationStatus(error instanceof Error ? error.message : "The password export could not be reviewed."));
  };
  const commitPasswordExport = () => {
    if (!passwordExportPreview) return;
    setMigrationStatus("Waiting for native encryption approval…");
    void window.openStrawberry.migration.commitPasswordExport(passwordExportPreview.importId).then((result) => { setPasswordExportPreview(null); setMigrationStatus(result.note); }).catch((error: unknown) => { setPasswordExportPreview(null); setMigrationStatus(error instanceof Error ? error.message : "The password export was not imported."); });
  };
  const discardPasswordExport = () => {
    if (!passwordExportPreview) return;
    void window.openStrawberry.migration.discardPasswordExport(passwordExportPreview.importId);
    setPasswordExportPreview(null);
    setMigrationStatus("Password-export review discarded. The selected CSV was not imported.");
  };
  const selectBookmarkExport = (browserId: BrowserId) => {
    setMigrationStatus("Choose a Firefox or Safari bookmark HTML export in the native file picker…");
    void window.openStrawberry.migration.selectBookmarkExport(browserId).then((preview) => { setMigrationStatus(""); setBookmarkExportPreview(preview); }).catch((error: unknown) => setMigrationStatus(error instanceof Error ? error.message : "The bookmark export could not be reviewed."));
  };
  const commitBookmarkExport = () => {
    if (!bookmarkExportPreview) return;
    setMigrationStatus("Waiting for native bookmark-import approval…");
    void window.openStrawberry.migration.commitBookmarkExport(bookmarkExportPreview.importId).then((result) => { setBookmarkExportPreview(null); setMigrationStatus(result.note); }).catch((error: unknown) => { setBookmarkExportPreview(null); setMigrationStatus(error instanceof Error ? error.message : "The bookmark export was not imported."); });
  };
  const discardBookmarkExport = () => {
    if (!bookmarkExportPreview) return;
    void window.openStrawberry.migration.discardBookmarkExport(bookmarkExportPreview.importId);
    setBookmarkExportPreview(null);
    setMigrationStatus("Bookmark-export review discarded. The selected HTML file was not imported.");
  };
  const saveWorkspace = () => {
    setWorkspaceStatus("");
    void window.openStrawberry.workspaces.save(workspaceName).then((snapshot) => { if (snapshot) { setWorkspaces((current) => [snapshot, ...current]); setWorkspaceName(""); setWorkspaceStatus("Workspace saved locally."); } }).catch((error: unknown) => setWorkspaceStatus(error instanceof Error ? error.message : "Could not save workspace."));
  };
  const restoreWorkspace = (id: string) => {
    setWorkspaceStatus("Restoring workspace…");
    void window.openStrawberry.workspaces.restore(id).then((snapshot) => { if (snapshot) setBrowser(snapshot); setWorkspaceStatus("Workspace restored."); }).catch((error: unknown) => setWorkspaceStatus(error instanceof Error ? error.message : "Could not restore workspace."));
  };
  const createTabGroup = () => {
    if (!activeTab) return;
    setGroupStatus("Creating local tab group…");
    void window.openStrawberry.browser.createTabGroup({ name: groupName, color: groupColor, tabIds: [activeTab.id] }).then((snapshot) => { if (snapshot) setBrowser(snapshot); setGroupStatus("Tab group created."); }).catch((error: unknown) => setGroupStatus(error instanceof Error ? error.message : "Could not create tab group."));
  };
  const assignActiveTabToGroup = (groupId?: string) => {
    if (!activeTab) return;
    setGroupStatus("Updating local tab group…");
    void window.openStrawberry.browser.assignTabGroup({ tabId: activeTab.id, groupId }).then((snapshot) => { if (snapshot) setBrowser(snapshot); setGroupStatus(groupId ? "Active tab added to group." : "Active tab removed from group."); }).catch((error: unknown) => setGroupStatus(error instanceof Error ? error.message : "Could not update tab group."));
  };
  const toggleTabGroup = (id: string) => { void window.openStrawberry.browser.toggleTabGroup(id).then((snapshot) => { if (snapshot) setBrowser(snapshot); }).catch((error: unknown) => setGroupStatus(error instanceof Error ? error.message : "Could not toggle tab group.")); };
  const deleteTabGroup = (id: string) => { void window.openStrawberry.browser.deleteTabGroup(id).then((snapshot) => { if (snapshot) setBrowser(snapshot); setGroupStatus("Tab group removed; its tabs remain open."); }).catch((error: unknown) => setGroupStatus(error instanceof Error ? error.message : "Could not remove tab group.")); };
  const setTrackerBlocking = (enabled: boolean) => { void window.openStrawberry.browser.setTrackerBlocking(enabled).then((snapshot) => { if (snapshot) setBrowser(snapshot); setPrivacyStatus(enabled ? "Tracker blocking is on for new third-party requests." : "Tracker blocking is off for this local browser profile."); }).catch((error: unknown) => setPrivacyStatus(error instanceof Error ? error.message : "Could not change tracker blocking.")); };
  const toggleTrackerSiteException = () => { void window.openStrawberry.browser.toggleTrackerSiteException().then((snapshot) => { if (snapshot) setBrowser(snapshot); setPrivacyStatus(snapshot?.privacy.activeSiteException ? "Tracker blocking is allowed for this site." : "Tracker blocking is active for this site."); }).catch((error: unknown) => setPrivacyStatus(error instanceof Error ? error.message : "Could not change this site’s exception.")); };

  useEffect(() => setUrlInput(activeTab?.url ?? ""), [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    refreshMedia();
    const interval = window.setInterval(refreshMedia, 1800);
    return () => window.clearInterval(interval);
  }, [activeTab?.id, activeTab?.url, refreshMedia]);

  useEffect(() => {
    const observers: ResizeObserver[] = [];
    const observePane = (paneId: BrowserPaneId, element: HTMLDivElement | null) => {
      if (!element) return;
      const updateBounds = () => { const rect = element.getBoundingClientRect(); void window.openStrawberry.browser.setViewport({ paneId, x: rect.x, y: rect.y, width: rect.width, height: rect.height }); };
      const observer = new ResizeObserver(updateBounds);
      observer.observe(element); updateBounds(); observers.push(observer);
    };
    observePane("primary", primaryViewportRef.current);
    if (browser.splitEnabled) observePane("secondary", secondaryViewportRef.current);
    return () => observers.forEach((observer) => observer.disconnect());
  }, [agentRailOpen, browser.splitEnabled]);

  const navigate = () => { if (activeTab && urlInput.trim()) void window.openStrawberry.browser.navigate(activeTab.id, urlInput); };
  const createTab = () => void window.openStrawberry.browser.create("https://example.com", browser.activePaneId);
  const runCommand = (command: "back" | "forward" | "reload" | "stop") => { if (activeTab) void window.openStrawberry.browser.command(activeTab.id, command); };
  const assignToPane = (tabId: string, paneId: BrowserPaneId) => { void window.openStrawberry.browser.activate(tabId, paneId); };
  const runMediaCommand = (command: MediaCommand) => { void window.openStrawberry.media.command(command).then((state) => { if (state) setMedia(state); window.setTimeout(refreshMedia, 250); }); };
  const focusAddress = () => { addressInputRef.current?.focus(); addressInputRef.current?.select(); };
  const executePaletteAction = (action: string) => {
    if (action === "new-tab") createTab();
    if (action === "focus-address") focusAddress();
    if (action === "toggle-split") void window.openStrawberry.browser.setSplit(!browser.splitEnabled);
    if (action === "reader-mode") void window.openStrawberry.browser.toggleReaderMode();
    if (action === "open-workspaces") setWorkspaceDrawerOpen(true);
    if (action === "toggle-agents") setAgentRailOpen((value) => !value);
    setCommandPaletteOpen(false);
    setCommandQuery("");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && commandPaletteOpen) { event.preventDefault(); setCommandPaletteOpen(false); return; }
      const shortcut = resolveBrowserShortcut(event);
      if (shortcut === "none") return;
      event.preventDefault();
      if (shortcut === "command-palette") setCommandPaletteOpen(true);
      if (shortcut === "address-bar") focusAddress();
      if (shortcut === "new-tab") createTab();
      if (shortcut === "toggle-split") void window.openStrawberry.browser.setSplit(!browser.splitEnabled);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [browser.activePaneId, browser.splitEnabled, commandPaletteOpen]);

  return <div className="app-shell">
    <aside className="side-nav" aria-label="OpenStrawberry navigation">
      <div className="relay-mark" aria-label="OpenStrawberry"><span /><span /><span /></div>
      <div className="side-actions">
        <button className="side-action active" aria-label="Browser"><Globe2 size={17} /></button>
        <button className={`side-action ${workspaceDrawerOpen ? "active" : ""}`} aria-label="Workspaces" onClick={() => setWorkspaceDrawerOpen((value) => !value)}><LayoutPanelTop size={17} /></button>
        <button className={`side-action ${downloadDrawerOpen ? "active" : ""}`} aria-label="Downloads" onClick={() => setDownloadDrawerOpen((value) => !value)}><Download size={17} /></button>
        <button className="side-action" aria-label="Settings"><Settings2 size={17} /></button>
      </div>
      <button className="side-action command" aria-label="Open command palette" onClick={() => setCommandPaletteOpen(true)}><Command size={16} /></button>
    </aside>

    <main className="browser-shell">
      <header className="product-bar">
        <div className="brand-lockup"><strong>Open</strong><span>Strawberry</span><em>LOCAL BROWSER</em></div>
        <div className="window-state"><ShieldCheck size={13} /> Local profile · agent vault locked</div>
        <div className="privacy-controls" aria-label="Tracker blocking controls"><button className={`privacy-toggle ${browser.privacy.trackerBlockingEnabled ? "active" : ""}`} onClick={() => setTrackerBlocking(!browser.privacy.trackerBlockingEnabled)} title="Toggle tracker blocking">{browser.privacy.trackerBlockingEnabled ? "Tracker block on" : "Tracker block off"}</button><button className="privacy-site-toggle" disabled={!activeSiteIsWeb} onClick={toggleTrackerSiteException} title="Toggle tracker blocking for the active site">{browser.privacy.activeSiteException ? "Allowed here" : "Block here"}</button>{browser.privacy.activeTabBlockedRequests > 0 && <span className="privacy-count" title="Blocked tracker requests in the active tab">{browser.privacy.activeTabBlockedRequests} blocked</span>}</div>
        <button className="agents-trigger" onClick={() => setAgentRailOpen((value) => !value)}><Bot size={14} /> Agents</button>
      </header>
      <div className="tabs-row"><div className="tab-list">
        {visibleTabs.map((tab) => <Tab key={tab.id} tab={tab} group={tab.groupId ? browser.groups.find((candidate) => candidate.id === tab.groupId) : undefined} active={tab.id === browser.activeTabId} onActivate={() => assignToPane(tab.id, browser.activePaneId)} onClose={() => void window.openStrawberry.browser.close(tab.id)} />)}
        <IconButton label="New tab" onClick={createTab}><Plus size={15} /></IconButton>
        <div className="pane-targets" aria-label="Split workspace targets">
          {(["primary", "secondary"] as const).map((paneId) => <button key={paneId} className={`pane-target ${browser.activePaneId === paneId ? "active" : ""}`} onClick={() => void window.openStrawberry.browser.setActivePane(paneId)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const tabId = event.dataTransfer.getData("application/x-openstrawberry-tab"); if (tabId) assignToPane(tabId, paneId); }}><span>{paneId === "primary" ? "A" : "B"}</span></button>)}
          <button className={`split-toggle ${browser.splitEnabled ? "active" : ""}`} onClick={() => void window.openStrawberry.browser.setSplit(!browser.splitEnabled)} aria-label={browser.splitEnabled ? "Close split view" : "Open split view"}><Columns2 size={14} /></button>
        </div>
      </div></div>
      {browser.groups.length > 0 && <div className="tab-group-strip" aria-label="Tab groups">{browser.groups.map((group) => <button key={group.id} className={`tab-group-chip ${group.color} ${group.collapsed ? "collapsed" : ""}`} onClick={() => toggleTabGroup(group.id)}><i /><span>{group.name}</span><b>{group.tabIds.length}</b></button>)}</div>}
      <div className="address-bar-row">
        <div className="nav-controls">
          <IconButton label="Back" disabled={!activeTab?.canGoBack} onClick={() => runCommand("back")}><ArrowLeft size={15} /></IconButton>
          <IconButton label="Forward" disabled={!activeTab?.canGoForward} onClick={() => runCommand("forward")}><ArrowRight size={15} /></IconButton>
          <IconButton label={activeTab?.isLoading ? "Stop" : "Reload"} onClick={() => runCommand(activeTab?.isLoading ? "stop" : "reload")}>{activeTab?.isLoading ? <CircleStop size={14} /> : <RefreshCw size={14} />}</IconButton>
        </div>
        <form className="address-bar" onSubmit={(event) => { event.preventDefault(); navigate(); }}><ShieldCheck size={14} /><input ref={addressInputRef} aria-label="Address or search" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="Search or enter address" /><button type="submit"><ArrowRight size={15} /></button></form>
        <IconButton label="Browser menu"><MoreHorizontal size={16} /></IconButton>
      </div>
      <MediaDock media={media} onCommand={runMediaCommand} onRefresh={refreshMedia} />
      <section className={`workspace-row ${browser.splitEnabled ? "is-split" : ""}`}>
        <div className="pane-stack">
          <div className={`browser-canvas pane-canvas ${browser.activePaneId === "primary" ? "active" : ""}`} ref={primaryViewportRef} aria-label="Primary browser page">{!browser.panes.find((pane) => pane.id === "primary")?.tabId && <EmptyPane onCreate={() => void window.openStrawberry.browser.create("https://example.com", "primary")} />}</div>
          {browser.splitEnabled && <div className={`browser-canvas pane-canvas ${browser.activePaneId === "secondary" ? "active" : ""}`} ref={secondaryViewportRef} aria-label="Secondary browser page">{!browser.panes.find((pane) => pane.id === "secondary")?.tabId && <EmptyPane onCreate={() => void window.openStrawberry.browser.create("https://example.com", "secondary")} />}</div>}
        </div>
        {agentRailOpen && <AgentRail activeView={agentView} onChange={setAgentView} onClose={() => setAgentRailOpen(false)} profiles={agents} localClis={localClis} sourceTabCount={browser.tabs.length} plan={orchestrationPlan} onProfilesChange={setAgents} onPlan={setOrchestrationPlan} />}
      </section>
    </main>
    {commandPaletteOpen && <CommandPalette query={commandQuery} onQueryChange={setCommandQuery} onClose={() => setCommandPaletteOpen(false)} onExecute={executePaletteAction} />}
    {downloadDrawerOpen && <DownloadDrawer downloads={browser.downloads} onReveal={(id) => void window.openStrawberry.browser.revealDownload(id)} onClose={() => setDownloadDrawerOpen(false)} />}
    {workspaceDrawerOpen && <WorkspaceDrawer name={workspaceName} status={workspaceStatus} workspaces={workspaces} onNameChange={setWorkspaceName} onSave={saveWorkspace} onRestore={restoreWorkspace} onClose={() => setWorkspaceDrawerOpen(false)}><TabGroupPanel groups={browser.groups} activeTab={activeTab} name={groupName} color={groupColor} status={groupStatus} onNameChange={setGroupName} onColorChange={setGroupColor} onCreate={createTabGroup} onAssign={assignActiveTabToGroup} onToggle={toggleTabGroup} onDelete={deleteTabGroup} /><PrivacyPanel enabled={browser.privacy.trackerBlockingEnabled} activeSiteIsWeb={activeSiteIsWeb} activeSiteException={browser.privacy.activeSiteException} blockedRequests={browser.privacy.activeTabBlockedRequests} status={privacyStatus} onEnabledChange={setTrackerBlocking} onToggleSiteException={toggleTrackerSiteException} /></WorkspaceDrawer>}
    {onboarding && !onboarding.completed && <OnboardingSheet candidates={migrationCandidates} status={migrationStatus} passwordPreview={passwordExportPreview} bookmarkPreview={bookmarkExportPreview} onImport={importMigration} onSelectPasswordExport={selectPasswordExport} onCommitPasswordExport={commitPasswordExport} onDiscardPasswordExport={discardPasswordExport} onSelectBookmarkExport={selectBookmarkExport} onCommitBookmarkExport={commitBookmarkExport} onDiscardBookmarkExport={discardBookmarkExport} onFresh={completeFreshProfile} />}
  </div>;
}

function WorkspaceDrawer({ name, status, workspaces, onNameChange, onSave, onRestore, onClose, children }: { name: string; status: string; workspaces: WorkspaceSnapshot[]; onNameChange: (name: string) => void; onSave: () => void; onRestore: (id: string) => void; onClose: () => void; children: ReactNode }) {
  return <aside className="workspace-drawer liquid-glass" aria-label="Saved workspaces"><header><div><p className="eyebrow">Local workspace snapshots</p><h2>Workspaces</h2></div><IconButton label="Close workspaces" onClick={onClose}><X size={15} /></IconButton></header><div className="workspace-drawer-content"><p>Save the current tabs, tab groups, and pane layout. A snapshot stores URLs and local group metadata only; it does not duplicate cookies, credentials, or page storage.</p><div className="workspace-save"><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Workspace name" aria-label="Workspace name" /><button className="primary-action" onClick={onSave}>Save snapshot</button></div>{status && <small className="workspace-status">{status}</small>}<div className="workspace-list">{workspaces.length === 0 ? <div className="workspace-empty">No saved workspaces yet.</div> : workspaces.map((workspace) => <button key={workspace.id} onClick={() => onRestore(workspace.id)}><span><strong>{workspace.name}</strong><em>{workspace.tabs.length} tabs · {workspace.groups?.length ?? 0} groups · {workspace.splitEnabled ? "split layout" : "single pane"}</em></span><b>Restore</b></button>)}</div>{children}</div></aside>;
}

function TabGroupPanel({ groups, activeTab, name, color, status, onNameChange, onColorChange, onCreate, onAssign, onToggle, onDelete }: { groups: BrowserTabGroup[]; activeTab: BrowserTabState | null; name: string; color: TabGroupColor; status: string; onNameChange: (value: string) => void; onColorChange: (value: TabGroupColor) => void; onCreate: () => void; onAssign: (groupId?: string) => void; onToggle: (id: string) => void; onDelete: (id: string) => void }) {
  return <section className="tab-group-panel" aria-label="Tab groups"><p className="eyebrow">Local tab groups</p><p>Group the active tab, collapse a focused set from the tab strip, and retain groups in saved workspaces.</p><div className="workspace-save"><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Group name" aria-label="Tab group name" /><select value={color} onChange={(event) => onColorChange(event.target.value as TabGroupColor)} aria-label="Tab group color">{TAB_GROUP_COLORS.map((value) => <option value={value} key={value}>{value}</option>)}</select><button className="secondary-action" disabled={!activeTab} onClick={onCreate}>Group active tab</button></div>{activeTab && <label className="tab-group-assignment">Active tab <select value={activeTab.groupId ?? ""} onChange={(event) => onAssign(event.target.value || undefined)}><option value="">No group</option>{groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select></label>}{status && <small className="workspace-status">{status}</small>}<div className="tab-group-list">{groups.length === 0 ? <div className="workspace-empty">No tab groups yet.</div> : groups.map((group) => <article key={group.id} className={`tab-group-record ${group.color}`}><div><i /><strong>{group.name}</strong><span>{group.tabIds.length} tab{group.tabIds.length === 1 ? "" : "s"} · {group.collapsed ? "collapsed" : "expanded"}</span></div><div><button className="secondary-action" onClick={() => onToggle(group.id)}>{group.collapsed ? "Expand" : "Collapse"}</button><button className="secondary-action" onClick={() => onDelete(group.id)}>Remove</button></div></article>)}</div></section>;
}

function PrivacyPanel({ enabled, activeSiteIsWeb, activeSiteException, blockedRequests, status, onEnabledChange, onToggleSiteException }: { enabled: boolean; activeSiteIsWeb: boolean; activeSiteException: boolean; blockedRequests: number; status: string; onEnabledChange: (enabled: boolean) => void; onToggleSiteException: () => void }) {
  return <section className="privacy-panel" aria-label="Tracker blocking"><p className="eyebrow">Transparent tracker blocking</p><p>OpenStrawberry blocks a conservative list of known analytics and pixel hosts in third-party subresources only. Navigation is never blocked by this baseline.</p><div className="privacy-panel-actions"><button className={`secondary-action ${enabled ? "selected" : ""}`} onClick={() => onEnabledChange(!enabled)}>{enabled ? "Turn tracker blocking off" : "Turn tracker blocking on"}</button><button className="secondary-action" disabled={!activeSiteIsWeb} onClick={onToggleSiteException}>{activeSiteException ? "Restore blocking for this site" : "Allow trackers for this site"}</button></div><small>{blockedRequests} tracker request{blockedRequests === 1 ? "" : "s"} blocked in the active tab. This counter resets when the tab closes; no full request log is shown here.</small>{status && <small className="workspace-status">{status}</small>}</section>;
}

function CommandPalette({ query, onQueryChange, onClose, onExecute }: { query: string; onQueryChange: (query: string) => void; onClose: () => void; onExecute: (action: string) => void }) {
  const visibleActions = PALETTE_ACTIONS.filter((action) => action.label.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="command-palette-backdrop" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={onClose}><div className="command-palette liquid-glass" onMouseDown={(event) => event.stopPropagation()}><div className="command-palette-input"><Command size={16} /><input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && visibleActions[0]) onExecute(visibleActions[0].id); }} placeholder="Search browser actions" aria-label="Search browser actions" /><button onClick={onClose} aria-label="Close command palette"><X size={14} /></button></div><div className="command-palette-list">{visibleActions.length ? visibleActions.map((action) => <button key={action.id} onClick={() => onExecute(action.id)}><span>{action.label}</span><kbd>{action.hint}</kbd></button>) : <p>No matching browser action.</p>}</div></div></section>;
}

function DownloadDrawer({ downloads, onReveal, onClose }: { downloads: BrowserSnapshot["downloads"]; onReveal: (id: string) => void; onClose: () => void }) {
  return <aside className="download-drawer liquid-glass" aria-label="Downloads"><header><div><p className="eyebrow">Local download activity</p><h2>Downloads</h2></div><IconButton label="Close downloads" onClick={onClose}><X size={15} /></IconButton></header><div className="download-drawer-content">{downloads.length === 0 ? <div className="workspace-empty">No downloads in this session.</div> : downloads.map((download) => { const progress = downloadProgress(download.receivedBytes, download.totalBytes); return <article className="download-record" key={download.id}><div><strong>{download.filename}</strong><span>{download.state === "completed" ? "Completed" : download.state === "cancelled" ? "Cancelled" : progress === null ? "Downloading…" : `${progress}% downloaded`}</span></div>{download.state === "progressing" && <div className="download-progress"><i style={{ width: `${progress ?? 18}%` }} /></div>}{download.state === "completed" && <button className="secondary-action" onClick={() => onReveal(download.id)}>Reveal in folder</button>}</article>; })}</div></aside>;
}

function OnboardingSheet({ candidates, status, passwordPreview, bookmarkPreview, onImport, onSelectPasswordExport, onCommitPasswordExport, onDiscardPasswordExport, onSelectBookmarkExport, onCommitBookmarkExport, onDiscardBookmarkExport, onFresh }: { candidates: BrowserMigrationCandidate[]; status: string; passwordPreview: PasswordExportPreview | null; bookmarkPreview: BookmarkExportPreview | null; onImport: (browserId: BrowserId) => void; onSelectPasswordExport: (browserId: BrowserId) => void; onCommitPasswordExport: () => void; onDiscardPasswordExport: () => void; onSelectBookmarkExport: (browserId: BrowserId) => void; onCommitBookmarkExport: () => void; onDiscardBookmarkExport: () => void; onFresh: () => void }) {
  if (passwordPreview) return <section className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Review password export"><div className="onboarding-sheet liquid-glass"><p className="eyebrow">Password export · review before import</p><h1>Import a selected export, never a browser vault.</h1><p><strong>{passwordPreview.fileName}</strong> contains {passwordPreview.entriesFound} compatible login{passwordPreview.entriesFound === 1 ? "" : "s"} across {passwordPreview.distinctSites} site{passwordPreview.distinctSites === 1 ? "" : "s"}. Password values remain in the main process and are not shown here.</p><div className="orchestration-note"><ShieldCheck size={15} /><span>{passwordPreview.note}</span></div><p>Confirming will encrypt the reviewed entries in OpenStrawberry-owned local storage using operating-system-backed protection. This release stages them only: it does not expose, autofill, sync, or send them to websites or agents.</p>{status && <p className="migration-status">{status}</p>}<div className="workspace-save"><button className="secondary-action" onClick={onDiscardPasswordExport}>Discard selected CSV</button><button className="primary-action" onClick={onCommitPasswordExport} disabled={Boolean(status)}>Encrypt and import</button></div><small>Delete the original readable CSV after import. Browser CSV exports are not encrypted.</small></div></section>;
  if (bookmarkPreview) return <section className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Review bookmark export"><div className="onboarding-sheet liquid-glass"><p className="eyebrow">Bookmark export · review before import</p><h1>Import selected HTML, never browser databases.</h1><p><strong>{bookmarkPreview.fileName}</strong> contains {bookmarkPreview.bookmarksFound} compatible web bookmark{bookmarkPreview.bookmarksFound === 1 ? "" : "s"}. Titles, HTTP(S) URLs, and folder paths are the only fields that will be copied.</p><div className="orchestration-note"><ShieldCheck size={15} /><span>{bookmarkPreview.note}</span></div><p>Confirming copies the reviewed bookmarks into OpenStrawberry-owned local storage. Passwords, cookies, sessions, history, account tokens, settings, `places.sqlite`, and Safari’s `Bookmarks.plist` remain untouched.</p>{status && <p className="migration-status">{status}</p>}<div className="workspace-save"><button className="secondary-action" onClick={onDiscardBookmarkExport}>Discard selected HTML</button><button className="primary-action" onClick={onCommitBookmarkExport} disabled={Boolean(status)}>Import reviewed bookmarks</button></div></div></section>;
  return <section className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Set up OpenStrawberry"><div className="onboarding-sheet liquid-glass"><p className="eyebrow">First launch · local profile</p><h1>Bring bookmarks, not a shadow copy.</h1><p>Choose a browser to import compatible bookmarks and its displayed default-search name, or start with a fresh OpenStrawberry profile. Passwords, sessions, cookies, payment data, account tokens, and history are never read during this setup.</p><div className="migration-list">{candidates.map((candidate) => <div key={candidate.id} className="migration-choice"><button disabled={!candidate.detected || Boolean(status)} onClick={() => onImport(candidate.id)}><span><strong>{candidate.label}</strong><em>{candidate.detected ? `${candidate.profileCount} profile${candidate.profileCount === 1 ? "" : "s"} detected · ${candidate.bookmarkImport === "supported" ? "bookmark import ready" : "export file required"}` : "Not detected"}</em></span><b>{candidate.detected ? "Select" : "Unavailable"}</b></button>{candidate.detected && <button className="secondary-action password-export-action" disabled={Boolean(status)} onClick={() => onSelectPasswordExport(candidate.id)}>Review exported password CSV</button>}{candidate.detected && candidate.bookmarkImport === "export-file-required" && <button className="secondary-action password-export-action" disabled={Boolean(status)} onClick={() => onSelectBookmarkExport(candidate.id)}>Review exported bookmarks HTML</button>}</div>)}</div>{status && <p className="migration-status">{status}</p>}<button className="secondary-action fresh-profile" onClick={onFresh}>Start with a fresh local profile</button><small>Passwords and Firefox/Safari bookmarks require separate user-selected export-file review steps. OpenStrawberry never reads browser password databases, cookies, sessions, payment data, account tokens, settings, or history.</small></div></section>;
}

function Tab({ tab, group, active, onActivate, onClose }: { tab: BrowserTabState; group?: BrowserTabGroup; active: boolean; onActivate: () => void; onClose: () => void }) {
  return <div className={`browser-tab ${active ? "selected" : ""} ${group ? "grouped" : ""}`} draggable onDragStart={(event) => event.dataTransfer.setData("application/x-openstrawberry-tab", tab.id)}><button className="tab-target" onClick={onActivate}><span className={tab.isLoading ? "tab-spinner" : "tab-dot"} style={group && !tab.isLoading ? { background: GROUP_COLORS[group.color] } : undefined} /><span>{tab.title || "New tab"}</span></button><button className="tab-close" onClick={onClose} aria-label={`Close ${tab.title || "tab"}`}><X size={13} /></button></div>;
}

function EmptyPane({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-browser"><div className="relay-mark large"><span /><span /><span /></div><h1>Open a real tab</h1><p>OpenStrawberry renders Chromium pages here.</p><button onClick={onCreate}>Create tab</button></div>;
}

function MediaDock({ media, onCommand, onRefresh }: { media: MediaState; onCommand: (command: MediaCommand) => void; onRefresh: () => void }) {
  const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
  const current = Math.min(Math.max(media.currentTime, 0), duration || 0);
  return <section className="media-dock" aria-label="Selected tab media controls">
    <div className="media-label"><span className="media-pulse" /><div><p className="eyebrow">Media deck</p><strong>{media.available ? media.title : "No active HTML video"}</strong></div></div>
    {media.available ? <>
      <button className="media-icon" onClick={() => onCommand({ action: "toggle" })} aria-label={media.isPlaying ? "Pause video" : "Play video"}>{media.isPlaying ? <Pause size={14} /> : <Play size={14} />}</button>
      <span className="media-time">{formatTime(current)} / {formatTime(duration)}</span>
      <input aria-label="Video timeline" className="media-range timeline" type="range" min="0" max={duration || 1} step="0.1" value={current} onChange={(event) => onCommand({ action: "seek", value: Number(event.target.value) })} />
      <button className="media-icon" onClick={() => onCommand({ action: "mute" })} aria-label={media.muted ? "Unmute video" : "Mute video"}>{media.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>
      <input aria-label="Volume" className="media-range volume" type="range" min="0" max="1" step="0.05" value={media.muted ? 0 : media.volume} onChange={(event) => onCommand({ action: "volume", value: Number(event.target.value) })} />
      <button className="media-float" disabled={!media.pictureInPictureSupported} onClick={() => onCommand({ action: "picture-in-picture" })}><Maximize2 size={13} /> Float</button>
    </> : <><span className="media-empty">Select a tab with an HTML5 video to control it or open native picture-in-picture.</span><button className="media-icon" onClick={onRefresh} aria-label="Refresh media detection"><RefreshCw size={13} /></button></>}
  </section>;
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function AgentRail({ activeView, onChange, onClose, profiles, localClis, sourceTabCount, plan, onProfilesChange, onPlan }: { activeView: "agents" | "orchestrate" | "runs"; onChange: (view: "agents" | "orchestrate" | "runs") => void; onClose: () => void; profiles: AgentProfileSummary[]; localClis: LocalCliStatus[]; sourceTabCount: number; plan: OrchestrationPlan | null; onProfilesChange: (profiles: AgentProfileSummary[]) => void; onPlan: (plan: OrchestrationPlan) => void }) {
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? "");
  const selected = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
  const [draft, setDraft] = useState<AgentProfileInput | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");
  const [runPrompt, setRunPrompt] = useState("Summarize the selected browser context and recommend the next verifiable step.");
  const [runResult, setRunResult] = useState<AgentRunResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setDraft({ id: selected.id, name: selected.name, role: selected.role, provider: selected.provider, model: selected.model, baseUrl: selected.baseUrl, executor: selected.executor });
    setApiKey("");
    setStatus("");
  }, [selected?.id]);

  const saveProfile = () => {
    if (!draft) return;
    setStatus("Saving local binding…");
    void window.openStrawberry.agents.save({ ...draft, apiKey: apiKey || undefined }).then((saved) => {
      if (!saved) return;
      onProfilesChange(profiles.map((profile) => profile.id === saved.id ? saved : profile));
      setApiKey("");
      setStatus("Saved locally. The key remains outside the renderer.");
    }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not save this binding."));
  };

  const createPlan = () => {
    const availableRoles = profiles.filter((profile) => profile.credentialStatus === "ready" || profile.executor === "local-cli").map((profile) => profile.role);
    void window.openStrawberry.orchestrator.createPlan({ objective: "Coordinate the selected browser context", sourceTabCount, availableRoles }).then(onPlan);
  };

  const startAgentRun = () => {
    if (!selected || selected.credentialStatus !== "ready") {
      setStatus("Configure a ready provider or local CLI binding before starting a run.");
      return;
    }
    setIsRunning(true);
    setRunResult(null);
    const run = selected.executor === "local-cli" ? window.openStrawberry.agents.runCli : window.openStrawberry.agents.runProvider;
    void run({ agentId: selected.id, prompt: runPrompt }).then((result) => {
      setRunResult(result);
      setIsRunning(false);
      onChange("runs");
    }).catch((error: unknown) => {
      setRunResult({ agentId: selected.id, provider: selected.provider, model: selected.model, text: "", startedAt: Date.now(), completedAt: Date.now(), status: "failed", error: error instanceof Error ? error.message : "The agent run failed." });
      setIsRunning(false);
      onChange("runs");
    });
  };

  return <aside className="agent-rail liquid-glass">
    <header><div><p className="eyebrow">OpenStrawberry control plane</p><h2>Companion</h2></div><IconButton label="Close agents" onClick={onClose}><PanelRightClose size={15} /></IconButton></header>
    <nav className="agent-tabs" aria-label="Agent control plane">{(["agents", "orchestrate", "runs"] as const).map((view) => <button key={view} className={activeView === view ? "selected" : ""} onClick={() => onChange(view)}>{view}</button>)}</nav>
    {activeView === "agents" && <section className="agent-content"><p className="eyebrow">Specialist registry</p>{profiles.map((agent) => <button className={`agent-card agent-select ${selected?.id === agent.id ? "selected" : ""}`} key={agent.id} onClick={() => setSelectedId(agent.id)}><div><strong>{agent.name}</strong><span>{agent.role} · {agent.provider}</span></div><span className="status">{agent.credentialStatus === "ready" ? "Ready" : agent.credentialStatus === "unavailable" ? "Unavailable" : "Set key"}</span></button>)}
      {draft && <div className="agent-editor"><p className="eyebrow">Agent binding</p><label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Provider<input value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} placeholder="OpenAI, Anthropic, OpenRouter…" /></label><label>Model<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Model identifier" /></label><label>Base URL <span>optional</span><input value={draft.baseUrl ?? ""} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://…" /></label><label>Executor<select value={draft.executor} onChange={(event) => setDraft({ ...draft, executor: event.target.value as AgentProfileInput["executor"] })}><option value="provider">Provider API</option><option value="local-cli">Local coding CLI</option></select></label>{draft.executor === "local-cli" && <div className="cli-detection">{localClis.map((cli) => <span key={cli.command} className={cli.available ? "detected" : "missing"}>{cli.label}: {cli.available ? "found" : "not found"}</span>)}</div>}<label>Agent API key <span>stored locally</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selected?.credentialStatus === "ready" ? "Saved — enter a value to replace" : "Paste a key for this agent only"} /></label><button className="secondary-action" onClick={saveProfile}><ShieldCheck size={14} /> Save local binding</button>{status && <p className="agent-status">{status}</p>}</div>}
      <div className="run-composer"><p className="eyebrow">Explicit agent run</p><textarea value={runPrompt} onChange={(event) => setRunPrompt(event.target.value)} aria-label="Agent task prompt" /><button className="primary-action" onClick={startAgentRun} disabled={isRunning || selected?.credentialStatus !== "ready"}>{isRunning ? "Awaiting agent…" : "Review and run"}</button><p>OpenStrawberry will ask for native confirmation before sending this task and selected URL references to the configured provider or local CLI.</p></div>
    </section>}
    {activeView === "orchestrate" && <section className="agent-content"><p className="eyebrow">Complex task orchestration</p><h3>Delegate with a visible plan.</h3><p className="muted">The Orchestrator creates a reviewable handoff graph from selected tabs. It does not send prompts or expose credentials until a future explicit-run step is approved.</p><button className="primary-action" onClick={createPlan}><Sparkles size={14} /> Create orchestration plan</button><div className="orchestration-note"><ShieldCheck size={15} /><span>Each specialist references its own local credential binding and receives only the context named in its step.</span></div>{plan && <div className="plan-preview"><p className="eyebrow">Draft plan · {plan.sourceTabCount} tabs</p>{plan.steps.map((step) => <div key={step.id} className="plan-step"><strong>{step.role}</strong><span>{step.title}</span><em>{step.contextPolicy}</em></div>)}{plan.warnings.map((warning) => <p className="plan-warning" key={warning}>{warning}</p>)}</div>}</section>}
    {activeView === "runs" && <section className="agent-content"><p className="eyebrow">Run result</p>{isRunning && <div className="empty-runs"><Bot size={22} /><strong>Agent run in progress</strong><span>The task is executing through the selected agent’s own local credential binding.</span></div>}{!isRunning && !runResult && <div className="empty-runs"><Bot size={22} /><strong>No recent runs</strong><span>Choose a configured provider or local-CLI agent, then use Review and run to create a deliberate local execution.</span></div>}{runResult && <div className="run-result"><div><strong>{runResult.status === "completed" ? "Completed" : "Not completed"}</strong><span>{runResult.provider} · {runResult.model}</span></div>{runResult.status === "completed" ? <pre>{runResult.text}</pre> : <p>{runResult.error}</p>}</div>}</section>}
  </aside>;
}
