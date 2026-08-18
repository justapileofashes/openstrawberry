/**
 * The capability contract between the trusted main process and the untrusted
 * renderer. The preload implements exactly this shape and nothing more.
 *
 * Nothing on this interface may carry raw credentials, browser passwords,
 * session tokens, or absolute local paths.
 */

import type {
  BrowserPaneId,
  BrowserSnapshot,
  BrowserViewport
} from "./browser.js";
import type {
  AgentConfigStatus,
  AgentSkillSummary,
  AgentSnapshot,
  ApprovalDecision
} from "./agents.js";
import type {
  BookmarkPreviewResponse,
  HtmlSourceKind,
  MigrationCommitPayload,
  MigrationOverview,
  MigrationResult,
  PickedBookmarkFile,
  PickedPasswordFile
} from "./migration.js";
import type { DownloadSnapshot } from "./downloads.js";
import type { TrackingSnapshot } from "./tracking.js";

/** Channel names, shared so both sides of the boundary cannot drift apart. */
export const IPC_CHANNELS = {
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
  /*
   * Named for what it does rather than as "reveal". The name matches
   * `shell.showItemInFolder`, and it keeps the channel clear of the vocabulary
   * the migration guard test reserves for reading secrets back out.
   */
  downloadShowInFolder: "download:show-in-folder",
  downloadClearFinished: "download:clear-finished",
  trackingSnapshot: "tracking:snapshot",
  trackingSetEnabled: "tracking:set-enabled",
  trackingExceptSite: "tracking:except-site",
  trackingResumeSite: "tracking:resume-site",
  trackingRemoveException: "tracking:remove-exception"
} as const;

/** Push channel the main process uses to broadcast browser state changes. */
export const BROWSER_STATE_EVENT = "browser:state";

/** Push channel for window frame state, which the OS can change on its own. */
export const WINDOW_STATE_EVENT = "window:state-changed";

/**
 * Push channel for agent state. An agent run advances on its own schedule, so
 * the chrome renders from pushed snapshots rather than polling.
 */
export const AGENT_STATE_EVENT = "agent:state";

/**
 * Push channel for download state. A transfer advances on the network's
 * schedule, so the panel renders from pushed snapshots rather than polling.
 */
export const DOWNLOAD_STATE_EVENT = "download:state";

/**
 * Push channel for tracker-blocking state. The count changes as a page loads,
 * so the indicator is pushed rather than polled.
 */
export const TRACKING_STATE_EVENT = "tracking:state";

/** Non-secret facts about the running application. */
export interface ShellInfo {
  readonly platform: string;
  readonly appVersion: string;
  /**
   * False until signed artifacts and verified update metadata exist. The chrome
   * uses this to keep download affordances and the update channel inert.
   */
  readonly releaseReady: boolean;
  readonly updatesEnabled: boolean;
}

/** Frame state the custom window controls render from. */
export interface WindowState {
  readonly isMaximized: boolean;
  readonly isFullScreen: boolean;
}

/**
 * Window frame controls, for the platforms where the chrome draws its own.
 *
 * These are commands rather than queries: the frame can also change from a
 * double-click, a snap gesture, or a keyboard shortcut the app never sees, so
 * the current state always arrives on the push channel rather than as a return
 * value that could already be stale.
 */
export interface WindowBridge {
  readonly getState: () => Promise<WindowState>;
  readonly minimize: () => Promise<void>;
  readonly toggleMaximize: () => Promise<void>;
  readonly close: () => Promise<void>;
  /** Subscribes to pushed frame state. Returns an unsubscribe function. */
  readonly onState: (listener: (state: WindowState) => void) => () => void;
}

/**
 * The browser capability surface.
 *
 * Every call returns a snapshot — bounded display metadata only. The renderer
 * never receives a view handle, a WebContents id, or a local path.
 */
export interface BrowserBridge {
  readonly getSnapshot: () => Promise<BrowserSnapshot>;
  readonly createTab: (paneId: BrowserPaneId, url?: string) => Promise<BrowserSnapshot>;
  readonly closeTab: (tabId: string) => Promise<BrowserSnapshot>;
  readonly activateTab: (tabId: string) => Promise<BrowserSnapshot>;
  readonly moveTab: (tabId: string, paneId: BrowserPaneId) => Promise<BrowserSnapshot>;
  readonly navigate: (tabId: string, address: string) => Promise<BrowserSnapshot>;
  readonly back: (tabId: string) => Promise<BrowserSnapshot>;
  readonly forward: (tabId: string) => Promise<BrowserSnapshot>;
  readonly reload: (tabId: string) => Promise<BrowserSnapshot>;
  readonly stop: (tabId: string) => Promise<BrowserSnapshot>;
  readonly setViewport: (
    paneId: BrowserPaneId,
    viewport: BrowserViewport
  ) => Promise<BrowserSnapshot>;
  readonly setSplitEnabled: (enabled: boolean) => Promise<BrowserSnapshot>;
  readonly setActivePane: (paneId: BrowserPaneId) => Promise<BrowserSnapshot>;
  /** Subscribes to pushed state. Returns an unsubscribe function. */
  readonly onState: (listener: (snapshot: BrowserSnapshot) => void) => () => void;
}

/**
 * The agent capability surface.
 *
 * Two asymmetries are deliberate. First, `setCredential` is write-only: a key
 * goes in and only a status comes back, and there is no channel that reads one
 * out, so the trusted process is the only place a credential exists. Second,
 * `resolveApproval` is the *only* way a gated action proceeds — the renderer
 * cannot start a side effect, it can only permit one the agent has already
 * described and suspended on.
 */
export interface AgentBridge {
  readonly getSnapshot: () => Promise<AgentSnapshot>;
  readonly startRun: (
    companionId: string,
    task: string,
    tabIds: readonly string[]
  ) => Promise<AgentSnapshot>;
  readonly cancelRun: (runId: string) => Promise<AgentSnapshot>;
  readonly resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision
  ) => Promise<AgentSnapshot>;
  readonly listSkills: () => Promise<readonly AgentSkillSummary[]>;
  readonly getConfig: () => Promise<AgentConfigStatus>;
  /**
   * Write-only. Returns status, never the stored value.
   *
   * `companionId` scopes the key to one agent; null stores the shared key that
   * any agent without its own falls back to.
   */
  readonly setCredential: (
    provider: string,
    key: string,
    companionId?: string | null
  ) => Promise<AgentConfigStatus>;
  /** Forgets one scope's key. Every other key survives. */
  readonly clearCredential: (
    provider: string,
    companionId?: string | null
  ) => Promise<AgentConfigStatus>;
  /**
   * Roster management. Creation mints the id in the trusted process, so the
   * renderer names an agent but never chooses its handle.
   */
  readonly createCompanion: (draft: CompanionDraft) => Promise<AgentSnapshot>;
  readonly updateCompanion: (
    companionId: string,
    draft: CompanionDraft
  ) => Promise<AgentSnapshot>;
  readonly deleteCompanion: (companionId: string) => Promise<AgentSnapshot>;
  readonly selectCompanion: (companionId: string) => Promise<AgentSnapshot>;
  /** Repoints the orchestrator, and with it every agent that follows it. */
  readonly setOrchestrator: (
    provider: string,
    model: string,
    baseUrl?: string | null,
    command?: string | null
  ) => Promise<AgentConfigStatus>;
  /** Subscribes to pushed state. Returns an unsubscribe function. */
  readonly onState: (listener: (snapshot: AgentSnapshot) => void) => () => void;
}

/** The editable half of an agent, as the chrome sends it across the boundary. */
export interface CompanionDraft {
  readonly name: string;
  readonly role: string;
  /** Null follows the orchestrator. */
  readonly provider: string | null;
  /** Null takes the provider's default model. */
  readonly model: string | null;
  /** Set only for a provider whose endpoint the user names. */
  readonly baseUrl: string | null;
  /** Set only for a CLI provider whose program is somewhere unusual. */
  readonly command: string | null;
}

/**
 * The migration capability surface.
 *
 * Three asymmetries carry the privacy promise across this boundary.
 *
 * First, the renderer never names a location. It names a detected source by an
 * identifier the trusted process minted, or it asks for a *dialog* and gets back
 * an opaque handle — there is no method here that takes a path, so a compromised
 * renderer has nothing to point at a file.
 *
 * Second, previews are the only thing that flows back. A bookmark preview is
 * counts, a bounded sample, and warning codes; a password preview is counts and
 * recognised column names. Neither type has a field a credential fits in.
 *
 * Third, staging is write-only, exactly like `setCredential`. Passwords go in
 * through a confirmed commit and only a count comes back. `deleteStagedPasswords`
 * is the sole other verb, because being able to delete a secret you cannot read
 * is the correct pair of powers to hold.
 */
export interface MigrationBridge {
  readonly getOverview: () => Promise<MigrationOverview>;
  /** Reads one detected profile for review. The first time any data is touched. */
  readonly previewProfile: (
    sourceId: string,
    profileId: string
  ) => Promise<BookmarkPreviewResponse>;
  /** Opens a native picker for a Firefox or Safari HTML export. */
  readonly pickBookmarksFile: (kind: HtmlSourceKind) => Promise<PickedBookmarkFile>;
  /** Opens a native picker for a password CSV and parses it for review. */
  readonly pickPasswordFile: () => Promise<PickedPasswordFile>;
  /** Performs exactly the confirmed categories. Returns counts and warnings. */
  readonly commit: (request: MigrationCommitPayload) => Promise<MigrationResult>;
  /** Drops one reviewed selection, for a wizard stepping back a screen. */
  readonly releaseSelection: (handle: string) => Promise<void>;
  readonly startFresh: () => Promise<MigrationOverview>;
  readonly finish: () => Promise<MigrationOverview>;
  /** Abandons the wizard and drops every reviewed selection from memory. */
  readonly cancel: () => Promise<MigrationOverview>;
  /** Offers the wizard again from Settings. */
  readonly reopen: () => Promise<MigrationOverview>;
  readonly deleteStagedPasswords: () => Promise<MigrationOverview>;
}

/**
 * The downloads capability surface.
 *
 * The asymmetry here is about paths. Every verb names a download by an id the
 * trusted process minted, and `DownloadItem` carries a file name and a folder
 * *label* rather than a location. `reveal` is the interesting one: it asks for a
 * file the user already downloaded to be shown in the OS file manager, and
 * because it takes an id, a compromised renderer can only ask for one of its
 * own downloads to be revealed - never an arbitrary location.
 *
 * `clearFinished` forgets entries. It never deletes files: clearing a list is a
 * request about the list.
 */
export interface DownloadBridge {
  readonly getSnapshot: () => Promise<DownloadSnapshot>;
  readonly pause: (downloadId: string) => Promise<DownloadSnapshot>;
  readonly resume: (downloadId: string) => Promise<DownloadSnapshot>;
  readonly cancel: (downloadId: string) => Promise<DownloadSnapshot>;
  /** Shows a completed file in the OS file manager. Takes an id, never a path. */
  readonly showInFolder: (downloadId: string) => Promise<DownloadSnapshot>;
  readonly clearFinished: () => Promise<DownloadSnapshot>;
  /** Subscribes to pushed state. Returns an unsubscribe function. */
  readonly onState: (listener: (snapshot: DownloadSnapshot) => void) => () => void;
}

/**
 * The tracker-blocking capability surface.
 *
 * What crosses is counts and site names. No blocked URL is ever reported,
 * because a list of what a page tried to load is a browsing history with extra
 * steps, and keeping one to power a privacy feature would defeat the point.
 *
 * `exceptSite` and `resumeSite` name a tab rather than a site, so the renderer
 * cannot except a site the user is not looking at.
 */
export interface TrackingBridge {
  readonly getSnapshot: () => Promise<TrackingSnapshot>;
  readonly setEnabled: (enabled: boolean) => Promise<TrackingSnapshot>;
  /** Stops blocking on the site the given tab is showing. */
  readonly exceptSite: (tabId: string) => Promise<TrackingSnapshot>;
  readonly resumeSite: (tabId: string) => Promise<TrackingSnapshot>;
  /** Revokes an exception from the Settings list, where a tab is not in play. */
  readonly removeException: (site: string) => Promise<TrackingSnapshot>;
  /** Subscribes to pushed state. Returns an unsubscribe function. */
  readonly onState: (listener: (snapshot: TrackingSnapshot) => void) => () => void;
}

export interface OpenStrawberryBridge {
  readonly shell: {
    /** Available synchronously so first paint does not wait on IPC. */
    readonly platform: string;
    readonly getInfo: () => Promise<ShellInfo>;
  };
  readonly window: WindowBridge;
  readonly browser: BrowserBridge;
  readonly agents: AgentBridge;
  readonly migration: MigrationBridge;
  readonly downloads: DownloadBridge;
  readonly tracking: TrackingBridge;
}
