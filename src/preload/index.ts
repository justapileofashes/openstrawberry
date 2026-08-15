/* OpenStrawberry preload: typed browser controls only; no raw vault, filesystem, or Node access enters the renderer. */
import { contextBridge, ipcRenderer } from "electron";
import type { BrowserCommand, BrowserPaneId, BrowserSnapshot, BrowserViewport, WorkspaceSnapshot } from "../shared/browser.js";
import type { MediaCommand, MediaState } from "../shared/media.js";
import type { AgentProfileInput, AgentProfileSummary, LocalCliStatus } from "../shared/agent.js";
import type { OrchestrationPlan, OrchestrationRequest } from "../shared/orchestration.js";
import type { AgentRunRequest, AgentRunResult } from "../shared/agent-run.js";
import type { BrowserId, BrowserMigrationCandidate, MigrationImportResult, OnboardingState } from "../shared/migration.js";

contextBridge.exposeInMainWorld("openStrawberry", {
  browser: {
    ready: (): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:ready"),
    create: (input?: string, paneId?: BrowserPaneId): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:create", input, paneId),
    activate: (id: string, paneId?: BrowserPaneId): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:activate", id, paneId),
    close: (id: string): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:close", id),
    navigate: (id: string, input: string): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:navigate", id, input),
    command: (id: string, command: BrowserCommand): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:command", id, command),
    setViewport: (viewport: BrowserViewport): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:set-viewport", viewport),
    setSplit: (enabled: boolean): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:set-split", enabled),
    setActivePane: (paneId: BrowserPaneId): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("browser:set-active-pane", paneId),
    revealDownload: (id: string): Promise<boolean> => ipcRenderer.invoke("browser:reveal-download", id),
    onState: (listener: (snapshot: BrowserSnapshot) => void): (() => void) => { const handler = (_event: Electron.IpcRendererEvent, snapshot: BrowserSnapshot) => listener(snapshot); ipcRenderer.on("browser:state", handler); return () => ipcRenderer.removeListener("browser:state", handler); }
  },
  media: {
    state: (): Promise<MediaState | undefined> => ipcRenderer.invoke("media:state"),
    command: (command: MediaCommand): Promise<MediaState | undefined> => ipcRenderer.invoke("media:command", command)
  },
  workspaces: {
    list: (): Promise<WorkspaceSnapshot[]> => ipcRenderer.invoke("workspace:list"),
    save: (name: string): Promise<WorkspaceSnapshot | undefined> => ipcRenderer.invoke("workspace:save", name),
    restore: (id: string): Promise<BrowserSnapshot | undefined> => ipcRenderer.invoke("workspace:restore", id)
  },
  agents: {
    list: (): Promise<AgentProfileSummary[]> => ipcRenderer.invoke("agents:list"),
    save: (input: AgentProfileInput): Promise<AgentProfileSummary | undefined> => ipcRenderer.invoke("agents:save", input),
    detectLocalClis: (): Promise<LocalCliStatus[]> => ipcRenderer.invoke("agents:detect-local-clis"),
    runProvider: (request: Omit<AgentRunRequest, "context">): Promise<AgentRunResult> => ipcRenderer.invoke("agents:run-provider", request),
    runCli: (request: Omit<AgentRunRequest, "context">): Promise<AgentRunResult> => ipcRenderer.invoke("agents:run-cli", request)
  },
  orchestrator: {
    createPlan: (request: OrchestrationRequest): Promise<OrchestrationPlan> => ipcRenderer.invoke("orchestrator:create-plan", request)
  },
  migration: {
    state: (): Promise<OnboardingState> => ipcRenderer.invoke("migration:state"),
    detect: (): Promise<BrowserMigrationCandidate[]> => ipcRenderer.invoke("migration:detect"),
    importBrowser: (browserId: BrowserId): Promise<MigrationImportResult> => ipcRenderer.invoke("migration:import", browserId),
    complete: (browserId?: BrowserId): Promise<OnboardingState> => ipcRenderer.invoke("migration:complete", browserId)
  },
  app: { version: (): Promise<string> => ipcRenderer.invoke("app:version") }
});
