import type { AgentProfileInput, AgentProfileSummary, LocalCliStatus } from "../shared/agent";
import type { BrowserCommand, BrowserPaneId, BrowserSnapshot, BrowserViewport, WorkspaceSnapshot } from "../shared/browser";
import type { MediaCommand, MediaState } from "../shared/media";
import type { OrchestrationPlan, OrchestrationRequest } from "../shared/orchestration";
import type { AgentRunRequest, AgentRunResult } from "../shared/agent-run";
import type { BrowserId, BrowserMigrationCandidate, MigrationImportResult, OnboardingState, PasswordExportImportResult, PasswordExportPreview } from "../shared/migration";

declare global {
  interface Window {
    openStrawberry: {
      browser: {
        ready: () => Promise<BrowserSnapshot | undefined>;
        create: (input?: string, paneId?: BrowserPaneId) => Promise<BrowserSnapshot | undefined>;
        activate: (id: string, paneId?: BrowserPaneId) => Promise<BrowserSnapshot | undefined>;
        close: (id: string) => Promise<BrowserSnapshot | undefined>;
        navigate: (id: string, input: string) => Promise<BrowserSnapshot | undefined>;
        command: (id: string, command: BrowserCommand) => Promise<BrowserSnapshot | undefined>;
        setViewport: (viewport: BrowserViewport) => Promise<BrowserSnapshot | undefined>;
        setSplit: (enabled: boolean) => Promise<BrowserSnapshot | undefined>;
        setActivePane: (paneId: BrowserPaneId) => Promise<BrowserSnapshot | undefined>;
        revealDownload: (id: string) => Promise<boolean>;
        toggleReaderMode: () => Promise<boolean>;
        onState: (listener: (snapshot: BrowserSnapshot) => void) => () => void;
      };
      media: { state: () => Promise<MediaState | undefined>; command: (command: MediaCommand) => Promise<MediaState | undefined> };
      workspaces: { list: () => Promise<WorkspaceSnapshot[]>; save: (name: string) => Promise<WorkspaceSnapshot | undefined>; restore: (id: string) => Promise<BrowserSnapshot | undefined> };
      agents: { list: () => Promise<AgentProfileSummary[]>; save: (input: AgentProfileInput) => Promise<AgentProfileSummary | undefined>; detectLocalClis: () => Promise<LocalCliStatus[]>; runProvider: (request: Omit<AgentRunRequest, "context">) => Promise<AgentRunResult>; runCli: (request: Omit<AgentRunRequest, "context">) => Promise<AgentRunResult> };
      orchestrator: { createPlan: (request: OrchestrationRequest) => Promise<OrchestrationPlan> };
      migration: { state: () => Promise<OnboardingState>; detect: () => Promise<BrowserMigrationCandidate[]>; importBrowser: (browserId: BrowserId) => Promise<MigrationImportResult>; selectPasswordExport: (browserId: BrowserId) => Promise<PasswordExportPreview>; commitPasswordExport: (importId: string) => Promise<PasswordExportImportResult>; discardPasswordExport: (importId: string) => Promise<void>; complete: (browserId?: BrowserId) => Promise<OnboardingState> };
      app: { version: () => Promise<string> };
    };
  }
}

export {};
