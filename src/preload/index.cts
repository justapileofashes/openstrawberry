/**
 * The preload bridge is the only surface the untrusted renderer can reach. It
 * exposes a narrow, explicitly enumerated capability set and never forwards raw
 * IPC, Node APIs, filesystem access, or shell access.
 *
 * Note what is *not* here: no generic `invoke`, no channel parameter the
 * renderer controls, no `require`, no path or process handles. Each capability
 * is a named function bound to one fixed channel.
 *
 * Two constraints shape this file:
 *
 *   - It is authored as CommonJS (.cts) because packaged sandboxed Electron
 *     loads the compiled preload as .cjs.
 *   - A sandboxed preload may only require `electron`, never a local module, so
 *     the file must be self-contained. Shared contracts are therefore imported
 *     as types only, and channel names are inlined but pinned to the shared
 *     contract at compile time so the two cannot drift apart.
 */
import electron = require("electron");
import type {
  AGENT_STATE_EVENT as AgentStateEvent,
  BROWSER_STATE_EVENT as BrowserStateEvent,
  CompanionDraft,
  DOWNLOAD_STATE_EVENT as DownloadStateEvent,
  IPC_CHANNELS,
  TRACKING_STATE_EVENT as TrackingStateEvent,
  OpenStrawberryBridge,
  ShellInfo,
  WINDOW_STATE_EVENT as WindowStateEvent,
  WindowState
} from "../shared/bridge.js";
import type { DownloadSnapshot } from "../shared/downloads.js";
import type { TrackingSnapshot } from "../shared/tracking.js";
import type { ReaderState } from "../shared/reader.js";
import type { WorkspaceSnapshot } from "../shared/workspaces.js";
import type { MediaAction, MediaState } from "../shared/media.js";
import type { GroupColour } from "../shared/tab-groups.js";
import type { BookmarkPage } from "../shared/bookmarks.js";
import type { BrowserPaneId, BrowserSnapshot, BrowserViewport } from "../shared/browser.js";
import type {
  AgentConfigStatus,
  AgentSkillSummary,
  AgentSnapshot,
  ApprovalDecision
} from "../shared/agents.js";
import type {
  BookmarkPreviewResponse,
  HtmlSourceKind,
  MigrationCommitPayload,
  MigrationOverview,
  MigrationResult,
  PickedBookmarkFile,
  PickedPasswordFile
} from "../shared/migration.js";

type Channels = typeof IPC_CHANNELS;

const CHANNEL: Channels = {
  shellInfo: "shell:info",
  windowState: "window:state",
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  browserSnapshot: "browser:snapshot",
  browserCreateTab: "browser:create-tab",
  browserCloseTab: "browser:close-tab",
  browserActivateTab: "browser:activate-tab",
  browserMoveTab: "browser:move-tab",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserStop: "browser:stop",
  browserSetViewport: "browser:set-viewport",
  browserSetSplit: "browser:set-split",
  browserSetActivePane: "browser:set-active-pane",
  agentSnapshot: "agent:snapshot",
  agentStartRun: "agent:start-run",
  agentCancelRun: "agent:cancel-run",
  agentResolveApproval: "agent:resolve-approval",
  agentListSkills: "agent:list-skills",
  agentConfig: "agent:config",
  agentSetCredential: "agent:set-credential",
  agentClearCredential: "agent:clear-credential",
  agentCreateCompanion: "agent:create-companion",
  agentUpdateCompanion: "agent:update-companion",
  agentDeleteCompanion: "agent:delete-companion",
  agentSelectCompanion: "agent:select-companion",
  agentSetOrchestrator: "agent:set-orchestrator",
  migrationOverview: "migration:overview",
  migrationPreviewProfile: "migration:preview-profile",
  migrationPickBookmarks: "migration:pick-bookmarks",
  migrationPickPasswords: "migration:pick-passwords",
  migrationCommit: "migration:commit",
  migrationRelease: "migration:release",
  migrationStartFresh: "migration:start-fresh",
  migrationFinish: "migration:finish",
  migrationCancel: "migration:cancel",
  migrationReopen: "migration:reopen",
  migrationDeleteStaged: "migration:delete-staged",
  downloadSnapshot: "download:snapshot",
  downloadPause: "download:pause",
  downloadResume: "download:resume",
  downloadCancel: "download:cancel",
  downloadShowInFolder: "download:show-in-folder",
  downloadClearFinished: "download:clear-finished",
  trackingSnapshot: "tracking:snapshot",
  trackingSetEnabled: "tracking:set-enabled",
  trackingExceptSite: "tracking:except-site",
  trackingResumeSite: "tracking:resume-site",
  trackingRemoveException: "tracking:remove-exception",
  readerOpen: "reader:open",
  workspaceSnapshot: "workspace:snapshot",
  workspaceSave: "workspace:save",
  workspaceOpen: "workspace:open",
  workspaceRemove: "workspace:remove",
  mediaState: "media:state",
  mediaCommand: "media:command",
  groupCreate: "group:create",
  groupUpdate: "group:update",
  groupAssign: "group:assign",
  groupRemove: "group:remove",
  bookmarkSearch: "bookmark:search"
};

const STATE_EVENT: typeof BrowserStateEvent = "browser:state";
const WINDOW_EVENT: typeof WindowStateEvent = "window:state-changed";
const AGENT_EVENT: typeof AgentStateEvent = "agent:state";
const DOWNLOAD_EVENT: typeof DownloadStateEvent = "download:state";
const TRACKING_EVENT: typeof TrackingStateEvent = "tracking:state";

async function snapshotCall(channel: string, payload?: unknown): Promise<BrowserSnapshot> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as BrowserSnapshot;
}

async function agentCall(channel: string, payload?: unknown): Promise<AgentSnapshot> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as AgentSnapshot;
}

async function configCall(channel: string, payload?: unknown): Promise<AgentConfigStatus> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as AgentConfigStatus;
}

async function migrationCall(channel: string, payload?: unknown): Promise<MigrationOverview> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as MigrationOverview;
}

async function downloadCall(channel: string, payload?: unknown): Promise<DownloadSnapshot> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as DownloadSnapshot;
}

async function trackingCall(channel: string, payload?: unknown): Promise<TrackingSnapshot> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as TrackingSnapshot;
}

const api: OpenStrawberryBridge = {
  shell: {
    platform: process.platform,
    getInfo: async (): Promise<ShellInfo> =>
      (await electron.ipcRenderer.invoke(CHANNEL.shellInfo)) as ShellInfo
  },
  window: {
    getState: async (): Promise<WindowState> =>
      (await electron.ipcRenderer.invoke(CHANNEL.windowState)) as WindowState,
    minimize: async (): Promise<void> => {
      await electron.ipcRenderer.invoke(CHANNEL.windowMinimize);
    },
    toggleMaximize: async (): Promise<void> => {
      await electron.ipcRenderer.invoke(CHANNEL.windowToggleMaximize);
    },
    close: async (): Promise<void> => {
      await electron.ipcRenderer.invoke(CHANNEL.windowClose);
    },
    onState: (listener: (state: WindowState) => void): (() => void) => {
      const handler = (_event: unknown, state: WindowState): void => listener(state);
      electron.ipcRenderer.on(WINDOW_EVENT, handler);
      return () => electron.ipcRenderer.removeListener(WINDOW_EVENT, handler);
    }
  },
  browser: {
    getSnapshot: async () => snapshotCall(CHANNEL.browserSnapshot),
    createTab: async (paneId: BrowserPaneId, url?: string) =>
      snapshotCall(CHANNEL.browserCreateTab, { paneId, url }),
    closeTab: async (tabId: string) => snapshotCall(CHANNEL.browserCloseTab, { tabId }),
    activateTab: async (tabId: string) => snapshotCall(CHANNEL.browserActivateTab, { tabId }),
    moveTab: async (tabId: string, paneId: BrowserPaneId) =>
      snapshotCall(CHANNEL.browserMoveTab, { tabId, paneId }),
    navigate: async (tabId: string, address: string) =>
      snapshotCall(CHANNEL.browserNavigate, { tabId, address }),
    back: async (tabId: string) => snapshotCall(CHANNEL.browserBack, { tabId }),
    forward: async (tabId: string) => snapshotCall(CHANNEL.browserForward, { tabId }),
    reload: async (tabId: string) => snapshotCall(CHANNEL.browserReload, { tabId }),
    stop: async (tabId: string) => snapshotCall(CHANNEL.browserStop, { tabId }),
    setViewport: async (paneId: BrowserPaneId, viewport: BrowserViewport) =>
      snapshotCall(CHANNEL.browserSetViewport, { paneId, viewport }),
    setSplitEnabled: async (enabled: boolean) =>
      snapshotCall(CHANNEL.browserSetSplit, { enabled }),
    setActivePane: async (paneId: BrowserPaneId) =>
      snapshotCall(CHANNEL.browserSetActivePane, { paneId }),
    createGroup: async (tabId: string, name: string) =>
      snapshotCall(CHANNEL.groupCreate, { tabId, name }),
    // The colour is a palette token, not a CSS value; the trusted process
    // refuses anything outside the shipped set.
    updateGroup: async (
      groupId: string,
      name: string,
      colour: GroupColour,
      collapsed: boolean
    ) => snapshotCall(CHANNEL.groupUpdate, { groupId, name, colour, collapsed }),
    assignTabToGroup: async (tabId: string, groupId: string | null) =>
      snapshotCall(CHANNEL.groupAssign, { tabId, groupId }),
    removeGroup: async (groupId: string) => snapshotCall(CHANNEL.groupRemove, { groupId }),
    onState: (listener: (snapshot: BrowserSnapshot) => void): (() => void) => {
      // The raw IpcRendererEvent is deliberately not passed through; the
      // renderer receives only the snapshot payload.
      const handler = (_event: unknown, snapshot: BrowserSnapshot): void => listener(snapshot);
      electron.ipcRenderer.on(STATE_EVENT, handler);
      return () => electron.ipcRenderer.removeListener(STATE_EVENT, handler);
    }
  },
  agents: {
    getSnapshot: async () => agentCall(CHANNEL.agentSnapshot),
    startRun: async (companionId: string, task: string, tabIds: readonly string[]) =>
      agentCall(CHANNEL.agentStartRun, { companionId, task, tabIds }),
    cancelRun: async (runId: string) => agentCall(CHANNEL.agentCancelRun, { runId }),
    resolveApproval: async (approvalId: string, decision: ApprovalDecision) =>
      agentCall(CHANNEL.agentResolveApproval, { approvalId, decision }),
    listSkills: async (): Promise<readonly AgentSkillSummary[]> =>
      (await electron.ipcRenderer.invoke(
        CHANNEL.agentListSkills
      )) as readonly AgentSkillSummary[],
    getConfig: async () => configCall(CHANNEL.agentConfig),
    // One direction only. The key is handed to the trusted process and what
    // comes back is status, so no path exists for reading a stored key out.
    setCredential: async (provider: string, key: string, companionId?: string | null) =>
      configCall(CHANNEL.agentSetCredential, {
        provider,
        key,
        companionId: companionId ?? null
      }),
    clearCredential: async (provider: string, companionId?: string | null) =>
      configCall(CHANNEL.agentClearCredential, {
        provider,
        companionId: companionId ?? null
      }),
    createCompanion: async (draft: CompanionDraft) =>
      agentCall(CHANNEL.agentCreateCompanion, draft),
    updateCompanion: async (companionId: string, draft: CompanionDraft) =>
      agentCall(CHANNEL.agentUpdateCompanion, { companionId, ...draft }),
    deleteCompanion: async (companionId: string) =>
      agentCall(CHANNEL.agentDeleteCompanion, { companionId }),
    selectCompanion: async (companionId: string) =>
      agentCall(CHANNEL.agentSelectCompanion, { companionId }),
    setOrchestrator: async (
      provider: string,
      model: string,
      baseUrl?: string | null,
      command?: string | null
    ) =>
      configCall(CHANNEL.agentSetOrchestrator, {
        provider,
        model,
        baseUrl: baseUrl ?? null,
        command: command ?? null
      }),
    onState: (listener: (snapshot: AgentSnapshot) => void): (() => void) => {
      const handler = (_event: unknown, snapshot: AgentSnapshot): void => listener(snapshot);
      electron.ipcRenderer.on(AGENT_EVENT, handler);
      return () => electron.ipcRenderer.removeListener(AGENT_EVENT, handler);
    }
  },
  migration: {
    getOverview: async () => migrationCall(CHANNEL.migrationOverview),
    // Names a detected profile by identifier. Note what this cannot express: a
    // path. There is no method on this object that accepts one.
    previewProfile: async (sourceId: string, profileId: string): Promise<BookmarkPreviewResponse> =>
      (await electron.ipcRenderer.invoke(CHANNEL.migrationPreviewProfile, {
        sourceId,
        profileId
      })) as BookmarkPreviewResponse,
    // The dialog is opened by the trusted process. The renderer asks for one and
    // receives a handle, never the location the user chose.
    pickBookmarksFile: async (kind: HtmlSourceKind): Promise<PickedBookmarkFile> =>
      (await electron.ipcRenderer.invoke(CHANNEL.migrationPickBookmarks, {
        kind
      })) as PickedBookmarkFile,
    pickPasswordFile: async (): Promise<PickedPasswordFile> =>
      (await electron.ipcRenderer.invoke(CHANNEL.migrationPickPasswords)) as PickedPasswordFile,
    // Write-only for credentials: the request carries a handle and the reply
    // carries a count, so no path exists for reading a staged password out.
    commit: async (request: MigrationCommitPayload): Promise<MigrationResult> =>
      (await electron.ipcRenderer.invoke(CHANNEL.migrationCommit, request)) as MigrationResult,
    releaseSelection: async (handle: string): Promise<void> => {
      await electron.ipcRenderer.invoke(CHANNEL.migrationRelease, { handle });
    },
    startFresh: async () => migrationCall(CHANNEL.migrationStartFresh),
    finish: async () => migrationCall(CHANNEL.migrationFinish),
    cancel: async () => migrationCall(CHANNEL.migrationCancel),
    reopen: async () => migrationCall(CHANNEL.migrationReopen),
    deleteStagedPasswords: async () => migrationCall(CHANNEL.migrationDeleteStaged),
    // A bounded page comes back, never the whole store.
    searchBookmarks: async (query: string): Promise<BookmarkPage> =>
      (await electron.ipcRenderer.invoke(CHANNEL.bookmarkSearch, { query })) as BookmarkPage
  },
  downloads: {
    getSnapshot: async () => downloadCall(CHANNEL.downloadSnapshot),
    pause: async (downloadId: string) => downloadCall(CHANNEL.downloadPause, { downloadId }),
    resume: async (downloadId: string) => downloadCall(CHANNEL.downloadResume, { downloadId }),
    cancel: async (downloadId: string) => downloadCall(CHANNEL.downloadCancel, { downloadId }),
    // Names a download this process already knows about. Note what it cannot
    // express: a location. There is no path parameter here to point elsewhere.
    showInFolder: async (downloadId: string) =>
      downloadCall(CHANNEL.downloadShowInFolder, { downloadId }),
    clearFinished: async () => downloadCall(CHANNEL.downloadClearFinished),
    onState: (listener: (snapshot: DownloadSnapshot) => void): (() => void) => {
      const handler = (_event: unknown, snapshot: DownloadSnapshot): void => listener(snapshot);
      electron.ipcRenderer.on(DOWNLOAD_EVENT, handler);
      return () => electron.ipcRenderer.removeListener(DOWNLOAD_EVENT, handler);
    }
  },
  tracking: {
    getSnapshot: async () => trackingCall(CHANNEL.trackingSnapshot),
    setEnabled: async (enabled: boolean) =>
      trackingCall(CHANNEL.trackingSetEnabled, { enabled }),
    // Names a tab, not a site, so a site the user is not looking at cannot be
    // excepted from here.
    exceptSite: async (tabId: string) => trackingCall(CHANNEL.trackingExceptSite, { tabId }),
    resumeSite: async (tabId: string) => trackingCall(CHANNEL.trackingResumeSite, { tabId }),
    removeException: async (site: string) =>
      trackingCall(CHANNEL.trackingRemoveException, { site }),
    onState: (listener: (snapshot: TrackingSnapshot) => void): (() => void) => {
      const handler = (_event: unknown, snapshot: TrackingSnapshot): void => listener(snapshot);
      electron.ipcRenderer.on(TRACKING_EVENT, handler);
      return () => electron.ipcRenderer.removeListener(TRACKING_EVENT, handler);
    }
  },
  reader: {
    // One verb, and it is a read. Closing the view is renderer-local state and
    // needs no channel.
    open: async (tabId: string): Promise<ReaderState> =>
      (await electron.ipcRenderer.invoke(CHANNEL.readerOpen, { tabId })) as ReaderState
  },
  workspaces: {
    getSnapshot: async (): Promise<WorkspaceSnapshot> =>
      (await electron.ipcRenderer.invoke(CHANNEL.workspaceSnapshot)) as WorkspaceSnapshot,
    // A name only. What is open is read in the trusted process, so a workspace
    // records the real tabs rather than a list assembled here.
    save: async (name: string): Promise<WorkspaceSnapshot> =>
      (await electron.ipcRenderer.invoke(CHANNEL.workspaceSave, { name })) as WorkspaceSnapshot,
    open: async (workspaceId: string): Promise<BrowserSnapshot> =>
      (await electron.ipcRenderer.invoke(CHANNEL.workspaceOpen, {
        workspaceId
      })) as BrowserSnapshot,
    remove: async (workspaceId: string): Promise<WorkspaceSnapshot> =>
      (await electron.ipcRenderer.invoke(CHANNEL.workspaceRemove, {
        workspaceId
      })) as WorkspaceSnapshot
  },
  media: {
    getState: async (tabId: string): Promise<MediaState> =>
      (await electron.ipcRenderer.invoke(CHANNEL.mediaState, { tabId })) as MediaState,
    // An action identifier, never code. The script for it lives in the trusted
    // process and is selected by this value after validation.
    run: async (tabId: string, action: MediaAction): Promise<MediaState> =>
      (await electron.ipcRenderer.invoke(CHANNEL.mediaCommand, {
        tabId,
        action
      })) as MediaState
  }
};

electron.contextBridge.exposeInMainWorld("openstrawberry", api);
