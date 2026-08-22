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
  ApprovalDecision,
  ModelTuning
} from "./agents.js";
import type { ProviderTestResult } from "./provider-request.js";
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
import type { ReaderState } from "./reader.js";
import type { WorkspaceSnapshot } from "./workspaces.js";
import type { MediaAction, MediaState } from "./media.js";
import type { GroupColour } from "./tab-groups.js";
import type { BookmarkPage } from "./bookmarks.js";
import type { Plan, PlanDraftPayload } from "./orchestration.js";
import type { UpdateState } from "./updates.js";
import type { DefaultBrowserState } from "./default-browser.js";
import type { BubbleRect } from "./bubble.js";

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
  agentTestProvider: "agent:test-provider",
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
  bookmarkSearch: "bookmark:search",
  planSnapshot: "plan:snapshot",
  planPropose: "plan:propose",
  planApprove: "plan:approve",
  planResolveStep: "plan:resolve-step",
  planCancel: "plan:cancel",
  updateState: "update:state",
  updateCheck: "update:check",
  updateDownload: "update:download",
  updateInstall: "update:install",
  defaultBrowserState: "default-browser:state",
  defaultBrowserRequest: "default-browser:request",
  bubbleShow: "bubble:show",
  bubbleHide: "bubble:hide"
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

/** Push channel for orchestration plans, which advance without being asked. */
export const PLAN_STATE_EVENT = "plan:state";

/** Push channel for the update channel's own state. */
export const UPDATE_STATE_EVENT = "update:state-changed";

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
  /**
   * Tab groups.
   *
   * A group is born holding a tab, because an empty one has no rail presence.
   * `colour` is a token from a shipped palette, never a CSS value, so stored
   * state can never reach a style attribute. Removing a group releases its tabs
   * rather than closing them.
   */
  readonly createGroup: (tabId: string, name: string) => Promise<BrowserSnapshot>;
  readonly updateGroup: (
    groupId: string,
    name: string,
    colour: GroupColour,
    collapsed: boolean
  ) => Promise<BrowserSnapshot>;
  /** Null takes the tab out of whatever group it was in. */
  readonly assignTabToGroup: (
    tabId: string,
    groupId: string | null
  ) => Promise<BrowserSnapshot>;
  readonly removeGroup: (groupId: string) => Promise<BrowserSnapshot>;
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
    command?: string | null,
    tuning?: ModelTuning
  ) => Promise<AgentConfigStatus>;
  /**
   * Tries a configuration and reports whether it answered.
   *
   * Never throws, and never returns the provider's own error body — the result
   * is one of this app's codes plus a short line the chrome wrote, so a failed
   * test can be put on screen without putting remote text there.
   */
  readonly testProvider: (request: ProviderTestRequest) => Promise<ProviderTestResult>;
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
  /** Model settings. Every field null means "take the provider's answer". */
  readonly tuning: ModelTuning;
}

/**
 * A configuration offered up to be tried before it is saved.
 *
 * Deliberately not "the current configuration": the whole point of the button is
 * to answer "would this work" for something the user has typed and not applied,
 * so the route being tried is the one in the form.
 *
 * `companionId` names whose key to authenticate with — an agent's own if it has
 * one, the shared key otherwise — and null means the shared key alone. No key
 * crosses this boundary in either direction; the trusted process reads the
 * stored one exactly as a run would.
 */
export interface ProviderTestRequest {
  readonly provider: string;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly command: string | null;
  readonly tuning: ModelTuning;
  readonly companionId: string | null;
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
  /**
   * Searches the imported bookmarks.
   *
   * The filtering happens in the trusted process: the store holds far more
   * entries than should cross IPC, so what comes back is a bounded page and a
   * total rather than everything.
   */
  readonly searchBookmarks: (query: string) => Promise<BookmarkPage>;
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

/**
 * Reader mode.
 *
 * One verb, and it is a read: the chrome asks for a tab's article and receives
 * text. Nothing is fetched, nothing is sent to a provider, and closing the view
 * is renderer-local state that needs no channel at all.
 *
 * A `ReaderDocument` is the one place page content crosses into the trusted
 * renderer, and it is plain strings in a closed set of block kinds - no markup,
 * no URL, no attribute. The component renders them as React text nodes.
 */
export interface ReaderBridge {
  readonly open: (tabId: string) => Promise<ReaderState>;
}

/**
 * Named workspace snapshots.
 *
 * A workspace is addresses and labels. It carries no cookie, session, storage,
 * or credential, and no type on this surface has a field one would fit in, so
 * opening a saved workspace navigates to pages rather than restoring who you
 * were signed in as.
 *
 * `save` sends only a name; the trusted process reads the open tabs itself
 * rather than trusting a list the renderer assembled.
 */
export interface WorkspaceBridge {
  readonly getSnapshot: () => Promise<WorkspaceSnapshot>;
  readonly save: (name: string) => Promise<WorkspaceSnapshot>;
  /** Opens every address the workspace holds, alongside what is already open. */
  readonly open: (workspaceId: string) => Promise<BrowserSnapshot>;
  readonly remove: (workspaceId: string) => Promise<WorkspaceSnapshot>;
}

/**
 * Media controls for HTML video and audio.
 *
 * `run` takes an action identifier from a closed set, never code. The trusted
 * process holds one fixed script per action and selects by that identifier, so
 * there is no field on this surface through which a renderer could get
 * JavaScript evaluated in a page - the difference between a media control and a
 * remote-execution primitive.
 *
 * Each action is something the user could already do with the page's own
 * controls, so the chrome offering it grants no new capability.
 */
export interface MediaBridge {
  readonly getState: (tabId: string) => Promise<MediaState>;
  readonly run: (tabId: string, action: MediaAction) => Promise<MediaState>;
}

/**
 * Orchestration plans.
 *
 * `propose` builds a plan in draft and returns it for review; nothing runs until
 * `approve`. That ordering is enforced in the graph rather than here, so a
 * renderer cannot skip the review by calling in a different order.
 *
 * A plan carries step titles, statuses, and artifacts — never a credential, and
 * never a page's contents. A context grant is a list of tab ids the user
 * approved, which the trusted process resolves; the renderer never sees what a
 * step actually read.
 */
export interface PlanBridge {
  readonly getPlans: () => Promise<readonly Plan[]>;
  readonly propose: (draft: PlanDraftPayload) => Promise<readonly Plan[]>;
  readonly approve: (planId: string) => Promise<readonly Plan[]>;
  /** Answers a step waiting on a person. */
  readonly resolveStep: (
    planId: string,
    stepId: string,
    allow: boolean
  ) => Promise<readonly Plan[]>;
  readonly cancel: (planId: string) => Promise<readonly Plan[]>;
  readonly onState: (listener: (plans: readonly Plan[]) => void) => () => void;
}

/**
 * The update channel.
 *
 * Every verb can refuse, and a refusal returns `disabled` carrying its reasons
 * rather than throwing: "this build will never update itself, and here is why"
 * is a state to render, not an error to report.
 */
export interface UpdateBridge {
  readonly getState: () => Promise<UpdateState>;
  readonly check: () => Promise<UpdateState>;
  readonly download: () => Promise<UpdateState>;
  /** Restarts into a downloaded update. Separate from downloading on purpose. */
  readonly install: () => Promise<UpdateState>;
  readonly onState: (listener: (state: UpdateState) => void) => () => void;
}

/**
 * The default-browser request.
 *
 * Two verbs and no arguments between them, which is the whole safety story:
 * `request` names no protocol and no URL, so a compromised renderer can ask for
 * exactly one registration - the one the product exists to make - and nothing
 * else. Every refusal comes back as state carrying its reasons, so a build that
 * must not register itself is something the panel can explain rather than an
 * error it has to swallow.
 */
export interface DefaultBrowserBridge {
  readonly getState: () => Promise<DefaultBrowserState>;
  /** Asks the OS. May end in `pending` where the person finishes in Settings. */
  readonly request: () => Promise<DefaultBrowserState>;
}

/**
 * Hover text drawn above the pages.
 *
 * Two verbs, and between them they can do exactly one thing: put a short string
 * inside a rectangle of the chrome's own window. `show` names a place in the
 * chrome's client coordinates rather than on the screen, and the trusted process
 * clamps it to the window it owns — so this cannot be used to draw anywhere but
 * over OpenStrawberry itself. The string is rendered as text and never as
 * markup, which matters because a tab's title comes from the page.
 *
 * Only the controls that have nowhere else to go use this. A bubble that fits
 * inside the chrome is drawn by the stylesheet and never crosses IPC at all.
 */
export interface BubbleBridge {
  readonly show: (text: string, rect: BubbleRect) => Promise<void>;
  readonly hide: () => Promise<void>;
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
  readonly reader: ReaderBridge;
  readonly workspaces: WorkspaceBridge;
  readonly media: MediaBridge;
  readonly plans: PlanBridge;
  readonly updates: UpdateBridge;
  readonly defaultBrowser: DefaultBrowserBridge;
  readonly bubbles: BubbleBridge;
}
