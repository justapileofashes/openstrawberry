/* OpenStrawberry desktop shell: monochrome technical chrome with Liquid Glass reserved for Companion and control surfaces. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, CircleStop, Columns2, Command, Download, Globe2, LayoutPanelTop, Maximize2, MoreHorizontal, PanelRightClose, Pause, Play, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Volume2, VolumeX, X } from "lucide-react";
import type { BrowserPaneId, BrowserSnapshot, BrowserTabState } from "../shared/browser";
import { defaultAgentProfiles, type AgentProfileInput, type AgentProfileSummary, type LocalCliStatus } from "../shared/agent";
import { EMPTY_MEDIA_STATE, type MediaCommand, type MediaState } from "../shared/media";
import type { OrchestrationPlan } from "../shared/orchestration";

const EMPTY_SNAPSHOT: BrowserSnapshot = { activeTabId: null, activePaneId: "primary", splitEnabled: false, panes: [{ id: "primary", tabId: null }, { id: "secondary", tabId: null }], tabs: [], downloads: [] };

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
  const primaryViewportRef = useRef<HTMLDivElement>(null);
  const secondaryViewportRef = useRef<HTMLDivElement>(null);
  const activeTab = browser.tabs.find((tab) => tab.id === browser.activeTabId) ?? null;
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

  return <div className="app-shell">
    <aside className="side-nav" aria-label="OpenStrawberry navigation">
      <div className="relay-mark" aria-label="OpenStrawberry"><span /><span /><span /></div>
      <div className="side-actions">
        <button className="side-action active" aria-label="Browser"><Globe2 size={17} /></button>
        <button className="side-action" aria-label="Workspaces"><LayoutPanelTop size={17} /></button>
        <button className="side-action" aria-label="Downloads"><Download size={17} /></button>
        <button className="side-action" aria-label="Settings"><Settings2 size={17} /></button>
      </div>
      <button className="side-action command" aria-label="Open command palette"><Command size={16} /></button>
    </aside>

    <main className="browser-shell">
      <header className="product-bar">
        <div className="brand-lockup"><strong>Open</strong><span>Strawberry</span><em>LOCAL BROWSER</em></div>
        <div className="window-state"><ShieldCheck size={13} /> Local profile · agent vault locked</div>
        <button className="agents-trigger" onClick={() => setAgentRailOpen((value) => !value)}><Bot size={14} /> Agents</button>
      </header>
      <div className="tabs-row"><div className="tab-list">
        {browser.tabs.map((tab) => <Tab key={tab.id} tab={tab} active={tab.id === browser.activeTabId} onActivate={() => assignToPane(tab.id, browser.activePaneId)} onClose={() => void window.openStrawberry.browser.close(tab.id)} />)}
        <IconButton label="New tab" onClick={createTab}><Plus size={15} /></IconButton>
        <div className="pane-targets" aria-label="Split workspace targets">
          {(["primary", "secondary"] as const).map((paneId) => <button key={paneId} className={`pane-target ${browser.activePaneId === paneId ? "active" : ""}`} onClick={() => void window.openStrawberry.browser.setActivePane(paneId)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const tabId = event.dataTransfer.getData("application/x-openstrawberry-tab"); if (tabId) assignToPane(tabId, paneId); }}><span>{paneId === "primary" ? "A" : "B"}</span></button>)}
          <button className={`split-toggle ${browser.splitEnabled ? "active" : ""}`} onClick={() => void window.openStrawberry.browser.setSplit(!browser.splitEnabled)} aria-label={browser.splitEnabled ? "Close split view" : "Open split view"}><Columns2 size={14} /></button>
        </div>
      </div></div>
      <div className="address-bar-row">
        <div className="nav-controls">
          <IconButton label="Back" disabled={!activeTab?.canGoBack} onClick={() => runCommand("back")}><ArrowLeft size={15} /></IconButton>
          <IconButton label="Forward" disabled={!activeTab?.canGoForward} onClick={() => runCommand("forward")}><ArrowRight size={15} /></IconButton>
          <IconButton label={activeTab?.isLoading ? "Stop" : "Reload"} onClick={() => runCommand(activeTab?.isLoading ? "stop" : "reload")}>{activeTab?.isLoading ? <CircleStop size={14} /> : <RefreshCw size={14} />}</IconButton>
        </div>
        <form className="address-bar" onSubmit={(event) => { event.preventDefault(); navigate(); }}><ShieldCheck size={14} /><input aria-label="Address or search" value={urlInput} onChange={(event) => setUrlInput(event.target.value)} placeholder="Search or enter address" /><button type="submit"><ArrowRight size={15} /></button></form>
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
  </div>;
}

function Tab({ tab, active, onActivate, onClose }: { tab: BrowserTabState; active: boolean; onActivate: () => void; onClose: () => void }) {
  return <div className={`browser-tab ${active ? "selected" : ""}`} draggable onDragStart={(event) => event.dataTransfer.setData("application/x-openstrawberry-tab", tab.id)}><button className="tab-target" onClick={onActivate}><span className={tab.isLoading ? "tab-spinner" : "tab-dot"} /><span>{tab.title || "New tab"}</span></button><button className="tab-close" onClick={onClose} aria-label={`Close ${tab.title || "tab"}`}><X size={13} /></button></div>;
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

  return <aside className="agent-rail liquid-glass">
    <header><div><p className="eyebrow">OpenStrawberry control plane</p><h2>Companion</h2></div><IconButton label="Close agents" onClick={onClose}><PanelRightClose size={15} /></IconButton></header>
    <nav className="agent-tabs" aria-label="Agent control plane">{(["agents", "orchestrate", "runs"] as const).map((view) => <button key={view} className={activeView === view ? "selected" : ""} onClick={() => onChange(view)}>{view}</button>)}</nav>
    {activeView === "agents" && <section className="agent-content"><p className="eyebrow">Specialist registry</p>{profiles.map((agent) => <button className={`agent-card agent-select ${selected?.id === agent.id ? "selected" : ""}`} key={agent.id} onClick={() => setSelectedId(agent.id)}><div><strong>{agent.name}</strong><span>{agent.role} · {agent.provider}</span></div><span className="status">{agent.credentialStatus === "ready" ? "Ready" : agent.credentialStatus === "unavailable" ? "Unavailable" : "Set key"}</span></button>)}
      {draft && <div className="agent-editor"><p className="eyebrow">Agent binding</p><label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Provider<input value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} placeholder="OpenAI, Anthropic, OpenRouter…" /></label><label>Model<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="Model identifier" /></label><label>Base URL <span>optional</span><input value={draft.baseUrl ?? ""} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://…" /></label><label>Executor<select value={draft.executor} onChange={(event) => setDraft({ ...draft, executor: event.target.value as AgentProfileInput["executor"] })}><option value="provider">Provider API</option><option value="local-cli">Local coding CLI</option></select></label>{draft.executor === "local-cli" && <div className="cli-detection">{localClis.map((cli) => <span key={cli.command} className={cli.available ? "detected" : "missing"}>{cli.label}: {cli.available ? "found" : "not found"}</span>)}</div>}<label>Agent API key <span>stored locally</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={selected?.credentialStatus === "ready" ? "Saved — enter a value to replace" : "Paste a key for this agent only"} /></label><button className="secondary-action" onClick={saveProfile}><ShieldCheck size={14} /> Save local binding</button>{status && <p className="agent-status">{status}</p>}</div>}
    </section>}
    {activeView === "orchestrate" && <section className="agent-content"><p className="eyebrow">Complex task orchestration</p><h3>Delegate with a visible plan.</h3><p className="muted">The Orchestrator creates a reviewable handoff graph from selected tabs. It does not send prompts or expose credentials until a future explicit-run step is approved.</p><button className="primary-action" onClick={createPlan}><Sparkles size={14} /> Create orchestration plan</button><div className="orchestration-note"><ShieldCheck size={15} /><span>Each specialist references its own local credential binding and receives only the context named in its step.</span></div>{plan && <div className="plan-preview"><p className="eyebrow">Draft plan · {plan.sourceTabCount} tabs</p>{plan.steps.map((step) => <div key={step.id} className="plan-step"><strong>{step.role}</strong><span>{step.title}</span><em>{step.contextPolicy}</em></div>)}{plan.warnings.map((warning) => <p className="plan-warning" key={warning}>{warning}</p>)}</div>}</section>}
    {activeView === "runs" && <section className="agent-content"><p className="eyebrow">Active runs</p><div className="empty-runs"><Bot size={22} /><strong>No active runs</strong><span>Configure the specialists, inspect an orchestration draft, and approve a future execution adapter to begin.</span></div></section>}
  </aside>;
}
