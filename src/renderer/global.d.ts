import type { AgentProfileInput, AgentProfileSummary, LocalCliStatus } from "../shared/agent";
import type { BrowserCommand, BrowserPaneId, BrowserSnapshot, BrowserViewport } from "../shared/browser";
import type { MediaCommand, MediaState } from "../shared/media";
import type { OrchestrationPlan, OrchestrationRequest } from "../shared/orchestration";

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
        onState: (listener: (snapshot: BrowserSnapshot) => void) => () => void;
      };
      media: { state: () => Promise<MediaState | undefined>; command: (command: MediaCommand) => Promise<MediaState | undefined> };
      agents: { list: () => Promise<AgentProfileSummary[]>; save: (input: AgentProfileInput) => Promise<AgentProfileSummary | undefined>; detectLocalClis: () => Promise<LocalCliStatus[]> };
      orchestrator: { createPlan: (request: OrchestrationRequest) => Promise<OrchestrationPlan> };
      app: { version: () => Promise<string> };
    };
  }
}

export {};
