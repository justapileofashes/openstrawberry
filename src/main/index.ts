import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  net,
  safeStorage,
  session,
  shell,
  webContents
} from "electron";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  AGENT_STATE_EVENT,
  BROWSER_STATE_EVENT,
  DOWNLOAD_STATE_EVENT,
  IPC_CHANNELS,
  PLAN_STATE_EVENT,
  UPDATE_STATE_EVENT,
  TRACKING_STATE_EVENT,
  WINDOW_STATE_EVENT,
  type ShellInfo,
  type WindowState
} from "../shared/bridge.js";
import { parseDownloadIdPayload, type DownloadSnapshot } from "../shared/downloads.js";
import {
  parseTrackingEnabledPayload,
  parseTrackingExceptionPayload,
  parseTrackingSitePayload,
  type TrackingSnapshot
} from "../shared/tracking.js";
import {
  parseCompanionIdPayload,
  parseCreateCompanionPayload,
  parseCredentialScopePayload,
  parseProviderTestPayload,
  parseResolveApprovalPayload,
  parseRunIdPayload,
  parseSetCredentialPayload,
  parseSetOrchestratorPayload,
  parseStartRunPayload,
  parseUpdateCompanionPayload,
  type AgentSnapshot
} from "../shared/agents.js";
import {
  parseActivePanePayload,
  parseCreateTabPayload,
  parseMoveTabPayload,
  parseNavigatePayload,
  parseSplitPayload,
  parseTabIdPayload,
  parseViewportPayload,
  type BrowserSnapshot
} from "../shared/browser.js";
import {
  APP_ID,
  PROFILE_PARTITION,
  RELEASE_READY,
  UPDATE_CHANNEL_ENABLED,
  usesCustomWindowControls
} from "../shared/desktop-shell.js";
import {
  parseHtmlPickPayload,
  parseMigrationCommitPayload,
  parseMigrationHandlePayload,
  parseMigrationPreviewPayload
} from "../shared/migration.js";
import { isAllowedUrl, isLocalDocumentUrl } from "../shared/navigation.js";
import { BrowserManager } from "./browser-manager.js";
import { BubbleLayer } from "./bubble-layer.js";
import { parseBubblePayload } from "../shared/bubble.js";
import { launchTargetFromCommandLine } from "./launch-target.js";
import { DownloadManager } from "./download-manager.js";
import { TrackerBlocker } from "./tracker-blocker.js";
import { extractReaderDocument } from "./reader.js";
import { callProvider, callProviderTurn } from "./http-provider.js";
import { callCli, supportsBrowserTools, type SpawnedProcess } from "./cli-provider.js";
import { BrowserMcpServer } from "./mcp-server.js";
import { ScriptSandbox } from "./script-sandbox.js";
import { PlanRunner } from "./plan-runner.js";
import { UpdateManager } from "./update-manager.js";
import { isUpdateAllowed } from "../shared/updates.js";
import {
  createElectronUpdaterTransport,
  type UpdateTransport
} from "./update-transport.js";
import { readDefaultBrowserState, requestDefaultBrowser } from "./default-browser.js";
import {
  parsePlanDecisionPayload,
  parsePlanDraftPayload,
  parsePlanIdPayload
} from "../shared/orchestration.js";
import { parseReaderTabPayload, type ReaderState } from "../shared/reader.js";
import { WorkspaceStore } from "./workspace-store.js";
import { readMediaState, runMediaAction } from "./media.js";
import { installLoopbackAudio } from "./loopback-audio.js";
import {
  emptyMediaState,
  parseMediaCommandPayload,
  parseMediaTabPayload
} from "../shared/media.js";
import {
  parseAssignTabPayload,
  parseCreateGroupPayload,
  parseGroupIdPayload,
  parseUpdateGroupPayload
} from "../shared/tab-groups.js";
import { parseBookmarkQueryPayload } from "../shared/bookmarks.js";
import {
  parseSaveWorkspacePayload,
  parseWorkspaceIdPayload
} from "../shared/workspaces.js";
import { MigrationManager, type MigrationDialogPort } from "./migration-manager.js";
import {
  AgentManager,
  PROVIDER_TEST_TIMEOUT_MS,
  type BrowserPort
} from "./agent-manager.js";
import { SecretStore } from "./secret-store.js";
import { createOsCipher } from "./os-cipher.js";
import { buildAllowedUrlPrefixes } from "./ipc-security.js";
import {
  registerTrustedHandler,
  registerTrustedQuery,
  setTrustedRendererPolicy
} from "./ipc-router.js";

// Guest web content must never inherit Node. Enabling the sandbox before the
// app is ready applies it to every renderer the process later creates.
app.enableSandbox();

/*
 * The Application User Model ID is what makes Windows treat OpenStrawberry as
 * its own app rather than as an anonymous Electron host: it drives taskbar
 * grouping, the Start-menu entry, and pinning. It must match the ID stamped on
 * the installed shortcut, which electron-builder takes from `appId`, and it has
 * to be set before any window exists.
 */
app.setAppUserModelId(APP_ID);

/*
 * A browser must be one application, not one per launch. Without this, opening
 * a link spawns a second process with its own taskbar button and its own view
 * of the session file.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

const DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let downloadManager: DownloadManager | null = null;
let trackerBlocker: TrackerBlocker | null = null;
/*
 * Outlives a window, unlike the managers above: saved workspaces are a user's
 * own list, not per-window runtime state, and they hold nothing that needs
 * releasing at teardown.
 */
let workspaceStore: WorkspaceStore | null = null;
let agentManager: AgentManager | null = null;
/** Bound to a socket only while a run that can use it is live. */
let browserMcpServer: BrowserMcpServer | null = null;
/** Opens a hidden renderer only while a script is actually running in one. */
let scriptSandbox: ScriptSandbox | null = null;
let planRunner: PlanRunner | null = null;
let updateManager: UpdateManager | null = null;
/** Null in any build the gate refuses, which is the refusal, not a symptom. */
let updateTransport: UpdateTransport | null = null;
let migrationManager: MigrationManager | null = null;
/**
 * Holds the one window that is drawn above the pages, for the hover text that
 * has nowhere in the chrome to go. Opens its renderer on first hover.
 */
let bubbleLayer: BubbleLayer | null = null;
/** A link that arrived before the browser core existed. */
let pendingLaunchUrl: string | null = launchTargetFromCommandLine(process.argv);

function denyAllPermissions(target: Electron.Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

function sendToRenderer(channel: string, payload: unknown): void {
  const target = mainWindow;
  if (target === null || target.isDestroyed() || target.webContents.isDestroyed()) return;
  target.webContents.send(channel, payload);
}

/** Returns the live manager, or throws so the router can redact and report. */
function requireBrowserManager(): BrowserManager {
  if (browserManager === null) throw new Error("Browser manager is unavailable.");
  return browserManager;
}

/** Returns the live download runtime, or throws so the router can redact. */
function requireDownloadManager(): DownloadManager {
  if (downloadManager === null) throw new Error("Downloads are unavailable.");
  return downloadManager;
}

/** Returns the live tracker blocker, or throws so the router can redact. */
function requireTrackerBlocker(): TrackerBlocker {
  if (trackerBlocker === null) throw new Error("Tracking protection is unavailable.");
  return trackerBlocker;
}

/** Returns the workspace store, creating it on first use. */
function requireWorkspaceStore(): WorkspaceStore {
  workspaceStore ??= new WorkspaceStore({
    statePath: join(app.getPath("userData"), "workspaces.json")
  });
  return workspaceStore;
}

/**
 * The update runtime, created on first use.
 *
 * Its environment is three independent facts, assembled here where all three are
 * actually known: whether this build is packaged, whether the product considers
 * itself release ready, and whether the channel is switched on.
 */
function requireUpdateManager(): UpdateManager {
  updateManager ??= new UpdateManager({
    environment: {
      packaged: app.isPackaged,
      releaseReady: RELEASE_READY,
      channelEnabled: UPDATE_CHANNEL_ENABLED
    },
    currentVersion: app.getVersion(),
    publish: (state) => sendToRenderer(UPDATE_STATE_EVENT, state),
    transport: updateTransport
  });
  return updateManager;
}

/**
 * Builds the update transport, or does not.
 *
 * Called once during startup, and only when the gate is already open. A build
 * that must not update never loads `electron-updater` at all - the refusal is
 * not a branch inside the updater, it is the updater never existing.
 *
 * Prereleases are allowed deliberately: while the published artifacts are
 * prereleases, a channel that only accepted stable versions would find nothing
 * for as long as that is true, and report it as being up to date.
 */
async function prepareUpdateTransport(): Promise<void> {
  const environment = {
    packaged: app.isPackaged,
    releaseReady: RELEASE_READY,
    channelEnabled: UPDATE_CHANNEL_ENABLED
  };

  if (!isUpdateAllowed(environment)) return;

  try {
    updateTransport = await createElectronUpdaterTransport({
      allowPrerelease: true,
      log: (message) => console.warn(`[updates] ${message}`)
    });
  } catch (error) {
    // A transport that cannot be constructed leaves the manager with none,
    // which it already handles as a refusal. Failing to load the updater must
    // not take the application down with it.
    console.warn(`[updates] transport unavailable: ${String(error)}`);
    updateTransport = null;
  }
}

/** Returns the live plan runner, or throws so the router can redact. */
function requirePlanRunner(): PlanRunner {
  if (planRunner === null) throw new Error("Orchestration is unavailable.");
  return planRunner;
}

/** Returns the live agent runtime, or throws so the router can redact and report. */
function requireAgentManager(): AgentManager {
  if (agentManager === null) throw new Error("Agent runtime is unavailable.");
  return agentManager;
}

/** Returns the live migration runtime, or throws so the router can redact. */
function requireMigrationManager(): MigrationManager {
  if (migrationManager === null) throw new Error("Migration is unavailable.");
  return migrationManager;
}

/**
 * The native file picker, as migration needs it.
 *
 * The dialog is opened by the trusted process and parented to the chrome window,
 * so the user picks a file in an OS dialog rather than the renderer naming one.
 * Only the chosen path comes back, and it never leaves this process.
 *
 * `dontAddToRecent` matters here: a password export should not be left in the
 * operating system's recent-documents list because it was migrated once.
 */
function migrationDialogFor(window: BrowserWindow): MigrationDialogPort {
  return {
    openFile: async (request) => {
      const chosen = await dialog.showOpenDialog(window, {
        title: request.title,
        buttonLabel: request.buttonLabel,
        properties: ["openFile", "dontAddToRecent"],
        filters: [{ name: request.filterName, extensions: [...request.extensions] }]
      });

      if (chosen.canceled) return null;
      return chosen.filePaths[0] ?? null;
    }
  };
}

/**
 * The fetch every provider call goes out on.
 *
 * `net.fetch` rather than the global one so the request honours the system
 * proxy and certificate store the rest of the app uses, and so it is not the
 * renderer's fetch under any circumstance. It is given its own session, not the
 * browsing partition: a provider call is the application's, and must not carry
 * cookies the user picked up while browsing, nor deposit any there.
 */
function providerFetch(
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly redirect: "error";
    readonly signal: AbortSignal;
  }
): Promise<Response> {
  return net.fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: init.redirect,
    signal: init.signal
  });
}

/**
 * The narrow slice of the tab engine the agent runtime may use.
 *
 * Built here rather than handing over the manager itself, so the agent's reach
 * into the browser is one readable list instead of the whole class.
 */
function browserPortFor(manager: BrowserManager): BrowserPort {
  return {
    snapshot: () => manager.snapshot(),
    createTab: (paneId, url) => manager.createTab(paneId, url),
    closeTab: (tabId) => manager.closeTab(tabId),
    navigate: (tabId, address) => manager.navigate(tabId, address),
    goBack: (tabId) => manager.goBack(tabId),
    goForward: (tabId) => manager.goForward(tabId),
    reload: (tabId) => manager.reload(tabId),
    contentsFor: (tabId) => manager.contentsFor(tabId),
    generationFor: (tabId) => manager.navigationGenerationFor(tabId),
    viewportFor: (tabId) => manager.drawnViewportFor(tabId)
  };
}

/** Returns the live chrome window, or throws so the router can redact and report. */
function requireWindow(): BrowserWindow {
  const target = mainWindow;
  if (target === null || target.isDestroyed()) throw new Error("Window is unavailable.");
  return target;
}

function windowStateOf(target: BrowserWindow): WindowState {
  return { isMaximized: target.isMaximized(), isFullScreen: target.isFullScreen() };
}

/**
 * The window icon for development runs.
 *
 * Packaged builds take their icon from the executable that electron-builder
 * stamps, so this only matters when running from source, where the repository
 * layout puts resources two levels above the compiled main process.
 */
function developmentIconPath(): string | undefined {
  if (app.isPackaged) return undefined;
  const candidate = join(import.meta.dirname, "..", "..", "resources", "icon.png");
  return existsSync(candidate) ? candidate : undefined;
}

function createWindow(): void {
  const iconPath = developmentIconPath();

  const window = new BrowserWindow({
    ...(iconPath === undefined ? {} : { icon: iconPath }),
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#08080a",
    show: false,
    /*
     * macOS keeps its native inset traffic lights. Everywhere else the system
     * title bar is hidden and the chrome draws its own controls into the top
     * bar, which is already marked as the window's drag region. The frame itself
     * is kept, so the resize borders and the window shadow stay native.
     */
    titleBarStyle: usesCustomWindowControls(process.platform) ? "hidden" : "hiddenInset",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  });

  mainWindow = window;

  // Bind the trust boundary to this exact WebContents before the renderer can
  // reach any channel. Guest views get their own ids and so can never match.
  setTrustedRendererPolicy({
    trustedWebContentsId: window.webContents.id,
    allowedUrlPrefixes: buildAllowedUrlPrefixes(DEV_SERVER_URL)
  });

  /*
   * The shine's audio tap, bound to the same WebContents the IPC trust boundary
   * just claimed. This runs after the blanket denial applied at startup and
   * deliberately narrows rather than lifts it: see the module for what the
   * handler is structurally unable to hand back. Guests are untouched - they
   * render into the profile partition, which is left with no display-media
   * handler at all and so refuses capture outright.
   */
  installLoopbackAudio({
    session: window.webContents.session,
    trustedWebContentsId: window.webContents.id,
    platform: process.platform,
    webContentsIdForFrame: (frame) => {
      try {
        return webContents.fromFrame(frame as Electron.WebFrameMain)?.id ?? null;
      } catch {
        // A frame that has already gone cannot be identified, and unidentified
        // is refused.
        return null;
      }
    }
  });

  /*
   * The only thing this application draws above a page. Hover text for the tab
   * rail cannot be part of the chrome's document — a rail entry is 56px wide
   * with a native view immediately beside it — so it is a child window instead.
   * See src/main/bubble-layer.ts; nothing else may follow it up there.
   */
  bubbleLayer = new BubbleLayer({
    parent: window,
    preloadPath: join(import.meta.dirname, "../preload/bubble.cjs"),
    load: (bubble) =>
      DEV_SERVER_URL
        ? bubble.loadURL(new URL("bubble.html", DEV_SERVER_URL).toString())
        : bubble.loadFile(join(import.meta.dirname, "../renderer/bubble.html"))
  });

  const profileSession = session.fromPartition(PROFILE_PARTITION);

  const browser = new BrowserManager({
    window,
    profile: profileSession,
    sessionFilePath: join(app.getPath("userData"), "session.json"),
    publish: (snapshot: BrowserSnapshot) => sendToRenderer(BROWSER_STATE_EVENT, snapshot)
  });

  browserManager = browser;

  /*
   * Downloads are attached to the same partition the guests render into, so a
   * transfer a page starts is the one this manager adopts. The save directory
   * and the reveal call are the only two places a path exists, and both stay
   * here: the manager is given the directory and a reveal function, and the
   * renderer is told a folder label instead.
   */
  downloadManager = new DownloadManager({
    session: profileSession,
    downloadDir: app.getPath("downloads"),
    directoryLabel: "Downloads",
    statePath: join(app.getPath("userData"), "downloads.json"),
    reveal: (path: string) => shell.showItemInFolder(path),
    publish: (snapshot: DownloadSnapshot) => sendToRenderer(DOWNLOAD_STATE_EVENT, snapshot)
  });

  /*
   * Tracker blocking is attached to the same partition, so it sees every
   * subresource a guest requests. It is given a read-only view of the tab engine
   * because deciding whether a request is first-party needs the page it came
   * from, and nothing more: the port can answer questions about tabs and do
   * nothing to them.
   */
  trackerBlocker = new TrackerBlocker({
    webRequest: profileSession.webRequest,
    browser: {
      pageForWebContents: (id) => browser.pageForWebContents(id),
      focusedTab: () => browser.focusedTab()
    },
    statePath: join(app.getPath("userData"), "tracking.json"),
    publish: (snapshot: TrackingSnapshot) => sendToRenderer(TRACKING_STATE_EVENT, snapshot)
  });

  /*
   * The OS keychain, as the credential store needs it. `createOsCipher` owns the
   * judgement of when the platform's encryption is worth trusting â€” notably that
   * a keyringless Linux session does not count, however cheerfully
   * `safeStorage.isEncryptionAvailable()` answers.
   */
  const cipher = createOsCipher({ safeStorage, platform: process.platform });

  const secrets = new SecretStore({
    credentialPath: join(app.getPath("userData"), "agent-credentials.enc"),
    profilePath: join(app.getPath("userData"), "agent-profile.json"),
    cipher
  });

  // A key an earlier build wrote through the keyringless fallback is protected by
  // nothing, so it does not get to sit on disk. Narrow by construction: a key a
  // real keyring wrote is left alone, because that keyring may simply be locked.
  secrets.discardExposedCredential();

  /*
   * The browser, as something a separate process can reach.
   *
   * Constructed with the same narrow port the agent runtime already has, so an
   * MCP tool call and an in-process agent step reach the tab engine by exactly
   * one route. Nothing is bound at construction: the server opens its socket
   * when the first run that can use it starts, and closes it when the last one
   * ends.
   */
  /*
   * Where a `run` script executes: a hidden renderer with no Node, no network,
   * and nothing to call but the tools. Shared by both transports, because a
   * script written by a local CLI and one written by a hosted model should get
   * the same bounds, and because the sandbox holds no per-run state — the
   * authority comes with each call.
   */
  const sandbox = new ScriptSandbox();
  scriptSandbox = sandbox;

  const mcp = new BrowserMcpServer({
    browser: browserPortFor(browser),
    configDir: app.getPath("userData"),
    toolOptions: { scriptRunner: sandbox }
  });
  browserMcpServer = mcp;

  agentManager = new AgentManager({
    statePath: join(app.getPath("userData"), "agents.json"),
    browser: browserPortFor(browser),
    scriptRunner: sandbox,
    secrets,
    publish: (snapshot: AgentSnapshot) => sendToRenderer(AGENT_STATE_EVENT, snapshot),
    /*
     * The transport. `net.fetch` rather than the global one so the request
     * honours the system proxy and certificate store the rest of the app uses,
     * and so it is not the renderer's fetch under any circumstance.
     *
     * It is given its own session, not the browsing partition: a provider call
     * is the application's, and must not carry cookies the user picked up while
     * browsing, nor deposit any there.
     */
    provider: (request) =>
      callProvider({
        ...request,
        fetch: (url, init) => providerFetch(url, init)
      }),
    /*
     * The same transport, for a turn that carries tools. An agent on an API key
     * has no separate process to give a socket to, so its browser access is a
     * tool list on the request and a loop in this process - and it goes out over
     * exactly the same fetch, with exactly the same refusal to follow a
     * redirect, as a plain question does.
     */
    providerTurn: (request) =>
      callProviderTurn({
        ...request,
        fetch: (url, init) => providerFetch(url, init)
      }),
    /*
     * Local tools. The working directory is a scratch folder under userData
     * rather than the user's documents or the app's own install: a tool that
     * writes a file should not land it somewhere surprising, and should not be
     * able to see what is beside the application.
     */
    command: (request) =>
      callCli({
        ...request,
        cwd: app.getPath("userData"),
        spawn: (command, args, spawnOptions) =>
          spawn(command, [...args], spawnOptions) as unknown as SpawnedProcess
      }),
    /*
     * Handing a run the browser. Both halves are named here rather than assumed
     * inside the runtime: which programs can take a session is the CLI adapter's
     * knowledge, and opening one is the server's, so the runtime asks both
     * rather than deciding either.
     */
    browserSessions: (request) => mcp.open(request),
    supportsBrowserTools
  });

  /*
   * Orchestration. A step is executed through the agent runtime's own dispatch,
   * so a plan step and a chat turn reach a provider by exactly the same path -
   * two paths would be two places for the credential rule to be got right.
   *
   * The runner is given the open tab ids fresh for every step, because a grant
   * approved earlier is intersected with what is actually open at the moment the
   * step runs.
   */
  const agents = agentManager;
  planRunner = new PlanRunner({
    publish: (plans) => sendToRenderer(PLAN_STATE_EVENT, plans),
    openTabIds: () => browser.snapshot().tabs.map((tab) => tab.id),
    execute: (step, contextTabIds, signal) =>
      agents.dispatch(
        step.companionId,
        contextTabIds.length === 0
          ? step.title
          : `${step.title}\n\nGranted tabs: ${contextTabIds.join(", ")}`,
        signal
      )
  });

  /*
   * Migration shares the credential store's cipher, so the same judgement about
   * when this platform's encryption is worth trusting governs staged passwords
   * and provider keys alike. It is given the environment to resolve profile
   * roots against rather than reading `process.env` itself, which keeps the
   * whole registry testable.
   *
   * Nothing here runs at startup. The manager detects browsers the first time
   * the wizard asks, so a launch that never opens migration never looks at
   * another application's directories.
   */
  migrationManager = new MigrationManager({
    userDataDir: app.getPath("userData"),
    cipher,
    environment: {
      platform: process.platform,
      homeDir: app.getPath("home"),
      localAppData: process.env["LOCALAPPDATA"] ?? "",
      roamingAppData: process.env["APPDATA"] ?? ""
    },
    dialog: migrationDialogFor(window)
  });

  window.once("ready-to-show", () => window.show());

  /*
   * The frame can change without the chrome asking: a double-click on the drag
   * region, a snap gesture, Win+Up, or the OS restoring a session. The controls
   * therefore render from pushed state rather than from what they last
   * requested, so the maximise glyph cannot go stale.
   */
  const publishWindowState = (): void =>
    sendToRenderer(WINDOW_STATE_EVENT, windowStateOf(window));

  window.on("maximize", publishWindowState);
  window.on("unmaximize", publishWindowState);
  window.on("enter-full-screen", publishWindowState);
  window.on("leave-full-screen", publishWindowState);

  // The chrome itself must never navigate away or spawn native windows. Any
  // external link is handed to the operating system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event) => event.preventDefault());

  // Native views must be released while the window still exists. Doing this at
  // `closed` would touch an already-destroyed parent and surface an "Object has
  // been destroyed" dialog, so `close` runs first and `closed` is only a
  // backstop. Both paths are idempotent.
  let released = false;
  const releaseBrowserViews = (): void => {
    if (released) return;
    released = true;

    // Migration goes first and unconditionally: its handles hold parsed
    // bookmarks and parsed credentials, and a window closing mid-wizard must
    // drop those rather than leave them alive behind a closed surface.
    const migration = migrationManager;
    migrationManager = null;
    migration?.destroy();

    // The agent runtime is torn down next: it holds tab handles through its
    // port, and persisting its state must happen while those are still valid.
    const plans = planRunner;
    planRunner = null;
    plans?.destroy();

    const agents = agentManager;
    agentManager = null;
    agents?.destroy();

    // The socket goes after the runtime, not before: tearing the runtime down
    // settles every outstanding gate, and a child still holding a tool call open
    // should read that refusal rather than find the endpoint gone.
    const mcp = browserMcpServer;
    browserMcpServer = null;
    mcp?.destroy();

    // The sandbox goes with them: it removes its channel and drops the callers
    // it was holding, so a script window outliving this point has nothing to
    // call back into.
    const sandbox = scriptSandbox;
    scriptSandbox = null;
    sandbox?.destroy();

    // Downloads persist their history before the session they belong to goes.
    const downloads = downloadManager;
    downloadManager = null;
    downloads?.destroy();

    // The blocker persists the user's exceptions, and drops its per-page counts.
    const tracking = trackerBlocker;
    trackerBlocker = null;
    tracking?.destroy();

    const manager = browserManager;
    browserManager = null;
    manager?.destroy();

    // The bubble window is the parent's child, so it would go with it anyway.
    // Dropping it here means it goes while the parent is still alive to detach
    // the listeners it holds on it.
    const bubbles = bubbleLayer;
    bubbleLayer = null;
    bubbles?.destroy();
  };

  window.once("close", releaseBrowserViews);
  window.once("closed", () => {
    releaseBrowserViews();
    if (mainWindow === window) mainWindow = null;
  });

  const load = DEV_SERVER_URL
    ? window.loadURL(DEV_SERVER_URL)
    : window.loadFile(join(import.meta.dirname, "../renderer/index.html"));

  // Restore only once the chrome can receive pushed state.
  void load.then(() => {
    const manager = browserManager;
    if (manager === null) return;

    manager.restore();
    agentManager?.restore();
    downloadManager?.restore();

    /*
     * Apply the search engine a migration recorded. Only its name was ever
     * imported; `setSearchEngineName` resolves that against the templates this
     * app ships, so the address bar honours the user's choice without any URL
     * having crossed over from another browser.
     */
    try {
      manager.setSearchEngineName(migrationManager?.overview().state.defaultSearchName ?? null);
    } catch {
      // Migration being unavailable leaves the shipped default in place.
    }

    // A link or document that launched the app opens alongside the restored
    // session rather than replacing it.
    const launchUrl = pendingLaunchUrl;
    pendingLaunchUrl = null;
    if (launchUrl !== null) openLaunchTarget(manager, launchUrl);
  });
}

function registerIpcHandlers(): void {
  registerTrustedQuery(
    IPC_CHANNELS.shellInfo,
    (): ShellInfo => ({
      platform: process.platform,
      appVersion: app.getVersion(),
      releaseReady: RELEASE_READY,
      // Updates stay unavailable until signed artifacts and verified release
      // metadata exist. This is deliberately not configurable at runtime.
      updatesEnabled: false
    })
  );

  registerTrustedQuery(IPC_CHANNELS.windowState, () => windowStateOf(requireWindow()));

  registerTrustedQuery(IPC_CHANNELS.windowMinimize, () => {
    requireWindow().minimize();
  });

  registerTrustedQuery(IPC_CHANNELS.windowToggleMaximize, () => {
    const target = requireWindow();
    // Full screen is entered by other means and has its own exit; the maximise
    // control must not half-leave it and strand the window without a title bar.
    if (target.isFullScreen()) return;
    if (target.isMaximized()) target.unmaximize();
    else target.maximize();
  });

  registerTrustedQuery(IPC_CHANNELS.windowClose, () => {
    // `close` rather than `destroy`, so the teardown that releases the native
    // views still runs.
    requireWindow().close();
  });

  registerTrustedQuery(IPC_CHANNELS.browserSnapshot, () => requireBrowserManager().snapshot());

  registerTrustedHandler(IPC_CHANNELS.browserCreateTab, parseCreateTabPayload, (payload) =>
    requireBrowserManager().createTab(payload.paneId, payload.url)
  );

  registerTrustedHandler(IPC_CHANNELS.browserCloseTab, parseTabIdPayload, (payload) =>
    requireBrowserManager().closeTab(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserActivateTab, parseTabIdPayload, (payload) =>
    requireBrowserManager().activateTab(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserMoveTab, parseMoveTabPayload, (payload) =>
    requireBrowserManager().moveTabToPane(payload.tabId, payload.paneId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserNavigate, parseNavigatePayload, (payload) =>
    requireBrowserManager().navigate(payload.tabId, payload.address)
  );

  registerTrustedHandler(IPC_CHANNELS.browserBack, parseTabIdPayload, (payload) =>
    requireBrowserManager().goBack(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserForward, parseTabIdPayload, (payload) =>
    requireBrowserManager().goForward(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserReload, parseTabIdPayload, (payload) =>
    requireBrowserManager().reload(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserStop, parseTabIdPayload, (payload) =>
    requireBrowserManager().stop(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.browserSetViewport, parseViewportPayload, (payload) =>
    requireBrowserManager().setViewport(payload.paneId, payload.viewport)
  );

  registerTrustedHandler(IPC_CHANNELS.browserSetSplit, parseSplitPayload, (enabled) =>
    requireBrowserManager().setSplitEnabled(enabled)
  );

  registerTrustedHandler(IPC_CHANNELS.browserSetActivePane, parseActivePanePayload, (paneId) =>
    requireBrowserManager().setActivePane(paneId)
  );

  /*
   * Downloads. Every verb names an item by an id the trusted process minted;
   * none of them accepts a path, which is what keeps `downloadShowInFolder` from
   * being a way to open an arbitrary location.
   */
  registerTrustedQuery(IPC_CHANNELS.downloadSnapshot, () =>
    requireDownloadManager().snapshot()
  );

  registerTrustedHandler(IPC_CHANNELS.downloadPause, parseDownloadIdPayload, (payload) =>
    requireDownloadManager().pause(payload.downloadId)
  );

  registerTrustedHandler(IPC_CHANNELS.downloadResume, parseDownloadIdPayload, (payload) =>
    requireDownloadManager().resume(payload.downloadId)
  );

  registerTrustedHandler(IPC_CHANNELS.downloadCancel, parseDownloadIdPayload, (payload) =>
    requireDownloadManager().cancel(payload.downloadId)
  );

  registerTrustedHandler(IPC_CHANNELS.downloadShowInFolder, parseDownloadIdPayload, (payload) =>
    requireDownloadManager().showInFolder(payload.downloadId)
  );

  registerTrustedQuery(IPC_CHANNELS.downloadClearFinished, () =>
    requireDownloadManager().clearFinished()
  );

  /*
   * Tracker blocking. What crosses back is counts and site names; no blocked URL
   * is ever reported, because that list would be a browsing history.
   */
  registerTrustedQuery(IPC_CHANNELS.trackingSnapshot, () =>
    requireTrackerBlocker().snapshot()
  );

  registerTrustedHandler(
    IPC_CHANNELS.trackingSetEnabled,
    parseTrackingEnabledPayload,
    (payload) => requireTrackerBlocker().setEnabled(payload.enabled)
  );

  registerTrustedHandler(IPC_CHANNELS.trackingExceptSite, parseTrackingSitePayload, (payload) =>
    requireTrackerBlocker().exceptSite(payload.tabId)
  );

  registerTrustedHandler(IPC_CHANNELS.trackingResumeSite, parseTrackingSitePayload, (payload) =>
    requireTrackerBlocker().resumeSite(payload.tabId)
  );

  registerTrustedHandler(
    IPC_CHANNELS.trackingRemoveException,
    parseTrackingExceptionPayload,
    (payload) => requireTrackerBlocker().removeException(payload.site)
  );

  /*
   * Reader mode. Reads the DOM the guest already loaded and returns text; no
   * network call is made and no provider is involved. A tab with no live
   * contents reports unavailable rather than throwing, because "this page has no
   * reader view" is an ordinary answer.
   */
  registerTrustedHandler(IPC_CHANNELS.readerOpen, parseReaderTabPayload, async (payload) => {
    const contents = requireBrowserManager().contentsFor(payload.tabId);
    if (contents === null) return { status: "unavailable", reason: "no-page" } as ReaderState;
    return extractReaderDocument(contents);
  });

  /*
   * Workspaces. A snapshot is addresses and labels; there is no field on the
   * contract a cookie, session, or credential would fit in.
   */
  registerTrustedQuery(IPC_CHANNELS.workspaceSnapshot, () =>
    requireWorkspaceStore().snapshot()
  );

  // The renderer sends a name only. The open tabs are read here rather than
  // taken from a list the renderer assembled, so a workspace records what is
  // actually open.
  registerTrustedHandler(IPC_CHANNELS.workspaceSave, parseSaveWorkspacePayload, (payload) => {
    const tabs = requireBrowserManager()
      .snapshot()
      .tabs.map((tab) => ({ url: tab.url, title: tab.title }));
    return requireWorkspaceStore().save(payload.name, tabs);
  });

  registerTrustedHandler(IPC_CHANNELS.workspaceOpen, parseWorkspaceIdPayload, (payload) => {
    const manager = requireBrowserManager();
    const paneId = manager.snapshot().activePaneId;

    // Opened alongside what is already there rather than replacing it: closing
    // a user's tabs to honour "open" would be a destructive reading of the word.
    let snapshot = manager.snapshot();
    for (const url of requireWorkspaceStore().addressesFor(payload.workspaceId)) {
      snapshot = manager.createTab(paneId, url, { activate: false });
    }
    return snapshot;
  });

  registerTrustedHandler(IPC_CHANNELS.workspaceRemove, parseWorkspaceIdPayload, (payload) =>
    requireWorkspaceStore().remove(payload.workspaceId)
  );

  /*
   * Media. The renderer names an action from a closed set; the scripts live in
   * `media.ts` and are selected by that validated identifier, so nothing the
   * renderer sends is ever evaluated in a page.
   */
  registerTrustedHandler(IPC_CHANNELS.mediaState, parseMediaTabPayload, async (payload) => {
    const contents = requireBrowserManager().contentsFor(payload.tabId);
    return contents === null ? emptyMediaState() : readMediaState(contents);
  });

  registerTrustedHandler(IPC_CHANNELS.mediaCommand, parseMediaCommandPayload, async (payload) => {
    const contents = requireBrowserManager().contentsFor(payload.tabId);
    return contents === null ? emptyMediaState() : runMediaAction(contents, payload.action);
  });

  /*
   * Tab groups. Ids are minted in the manager, and a colour is validated
   * against the shipped palette rather than defaulted, so a payload carrying
   * anything else is refused rather than quietly accepted.
   */
  registerTrustedHandler(IPC_CHANNELS.groupCreate, parseCreateGroupPayload, (payload) =>
    requireBrowserManager().createGroup(payload.tabId, payload.name)
  );

  registerTrustedHandler(IPC_CHANNELS.groupUpdate, parseUpdateGroupPayload, (payload) =>
    requireBrowserManager().updateGroup(
      payload.groupId,
      payload.name,
      payload.colour,
      payload.collapsed
    )
  );

  registerTrustedHandler(IPC_CHANNELS.groupAssign, parseAssignTabPayload, (payload) =>
    requireBrowserManager().assignTabToGroup(payload.tabId, payload.groupId)
  );

  registerTrustedHandler(IPC_CHANNELS.groupRemove, parseGroupIdPayload, (payload) =>
    requireBrowserManager().removeGroup(payload.groupId)
  );

  /*
   * Orchestration plans. `propose` returns a draft for review; the graph itself
   * refuses to offer a runnable step until `approve`, so the ordering cannot be
   * skipped by calling these in a different sequence.
   */
  registerTrustedQuery(IPC_CHANNELS.planSnapshot, () => requirePlanRunner().snapshot());

  registerTrustedHandler(IPC_CHANNELS.planPropose, parsePlanDraftPayload, (payload) => {
    const runner = requirePlanRunner();
    runner.propose(payload.goal, payload.steps);
    return runner.snapshot();
  });

  registerTrustedHandler(IPC_CHANNELS.planApprove, parsePlanIdPayload, (payload) => {
    const runner = requirePlanRunner();
    runner.approve(payload.planId);
    return runner.snapshot();
  });

  registerTrustedHandler(
    IPC_CHANNELS.planResolveStep,
    parsePlanDecisionPayload,
    (payload) => {
      const runner = requirePlanRunner();
      runner.resolveApproval(payload.planId, payload.stepId, payload.allow);
      return runner.snapshot();
    }
  );

  registerTrustedHandler(IPC_CHANNELS.planCancel, parsePlanIdPayload, (payload) => {
    const runner = requirePlanRunner();
    runner.cancel(payload.planId);
    return runner.snapshot();
  });

  /*
   * Updates. Every verb re-asks the gate; a refusal returns `disabled` carrying
   * its reasons rather than throwing, because "this build will never update
   * itself" is a state to render rather than an error.
   */
  registerTrustedQuery(IPC_CHANNELS.updateState, () => requireUpdateManager().snapshot());
  registerTrustedQuery(IPC_CHANNELS.updateCheck, () => requireUpdateManager().check());
  registerTrustedQuery(IPC_CHANNELS.updateDownload, () => requireUpdateManager().download());
  registerTrustedQuery(IPC_CHANNELS.updateInstall, () => requireUpdateManager().install());

  registerTrustedQuery(IPC_CHANNELS.defaultBrowserState, () => readDefaultBrowserState());
  registerTrustedQuery(IPC_CHANNELS.defaultBrowserRequest, () => requestDefaultBrowser());

  /*
   * Hover text. Both verbs are silent when no layer exists — a bubble that
   * cannot be drawn is not a failure worth reporting to the chrome, which would
   * only be able to log it.
   */
  registerTrustedHandler(IPC_CHANNELS.bubbleShow, parseBubblePayload, (payload) => {
    bubbleLayer?.show(payload);
  });
  registerTrustedQuery(IPC_CHANNELS.bubbleHide, () => {
    bubbleLayer?.hide();
  });

  registerTrustedQuery(IPC_CHANNELS.agentSnapshot, () => requireAgentManager().snapshot());

  registerTrustedHandler(IPC_CHANNELS.agentStartRun, parseStartRunPayload, (payload) =>
    requireAgentManager().startRun(payload)
  );

  registerTrustedHandler(IPC_CHANNELS.agentCancelRun, parseRunIdPayload, (payload) =>
    requireAgentManager().cancelRun(payload.runId)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentResolveApproval,
    parseResolveApprovalPayload,
    (payload) => requireAgentManager().resolveApproval(payload)
  );

  registerTrustedQuery(IPC_CHANNELS.agentListSkills, () => requireAgentManager().listSkills());

  registerTrustedQuery(IPC_CHANNELS.agentConfig, () => requireAgentManager().getConfig());

  /*
   * Write-only. The key goes in and a status comes back; there is no channel
   * that reads one out, so the trusted process is the only place it exists.
   * A refusal to store â€” no OS encryption available â€” throws, and the chrome
   * avoids that path by reading `config.encryption` before offering the form.
   */
  registerTrustedHandler(
    IPC_CHANNELS.agentSetCredential,
    parseSetCredentialPayload,
    (payload) => requireAgentManager().setCredential(payload)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentClearCredential,
    parseCredentialScopePayload,
    (payload) => requireAgentManager().clearCredential(payload)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentCreateCompanion,
    parseCreateCompanionPayload,
    (payload) => requireAgentManager().createCompanion(payload)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentUpdateCompanion,
    parseUpdateCompanionPayload,
    (payload) => requireAgentManager().updateCompanion(payload)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentDeleteCompanion,
    parseCompanionIdPayload,
    (payload) => requireAgentManager().deleteCompanion(payload)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentSelectCompanion,
    parseCompanionIdPayload,
    (payload) => requireAgentManager().selectCompanion(payload)
  );

  registerTrustedHandler(
    IPC_CHANNELS.agentSetOrchestrator,
    parseSetOrchestratorPayload,
    (payload) => requireAgentManager().setOrchestrator(payload)
  );

  /*
   * Trying a configuration before it is applied.
   *
   * Nothing is stored by this channel and nothing is read out of storage
   * through it: the credential is read on this side, used for one request, and
   * dropped, and what goes back is one of this app's own codes. The timeout is
   * the manager's rather than a run's, so a provider that hangs cannot leave a
   * settings dialog waiting on the run-length budget.
   */
  registerTrustedHandler(
    IPC_CHANNELS.agentTestProvider,
    parseProviderTestPayload,
    async (payload) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVIDER_TEST_TIMEOUT_MS);
      try {
        return await requireAgentManager().testProvider(payload, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }
  );

  /*
   * Migration. Every channel below goes through the same router as everything
   * else, so each one verifies the sender is the chrome, validates the payload
   * with no coercion, and redacts any failure â€” which matters more here than
   * anywhere else, because a failure in this subsystem is the one most likely to
   * be carrying a local path.
   */
  registerTrustedQuery(IPC_CHANNELS.migrationOverview, () =>
    requireMigrationManager().overview()
  );

  // Identifiers only. The registry resolves them to a location; a source id the
  // registry did not mint resolves to nothing and is refused.
  registerTrustedHandler(
    IPC_CHANNELS.migrationPreviewProfile,
    parseMigrationPreviewPayload,
    (payload) => requireMigrationManager().previewChromiumProfile(payload)
  );

  registerTrustedHandler(IPC_CHANNELS.migrationPickBookmarks, parseHtmlPickPayload, (payload) =>
    requireMigrationManager().pickHtmlBookmarks(payload.kind)
  );

  registerTrustedQuery(IPC_CHANNELS.migrationPickPasswords, () =>
    requireMigrationManager().pickPasswordCsv()
  );

  registerTrustedHandler(IPC_CHANNELS.migrationCommit, parseMigrationCommitPayload, (payload) => {
    const result = requireMigrationManager().commit(payload);

    // A search engine imported in this run takes effect immediately, rather
    // than on the next launch. Still a name resolved against the shipped table.
    if (result.importedSearchName) browserManager?.setSearchEngineName(result.searchName);

    return result;
  });

  registerTrustedHandler(IPC_CHANNELS.migrationRelease, parseMigrationHandlePayload, (payload) => {
    requireMigrationManager().releaseHandle(payload.handle);
  });

  registerTrustedQuery(IPC_CHANNELS.migrationStartFresh, () =>
    requireMigrationManager().startFresh()
  );

  registerTrustedQuery(IPC_CHANNELS.migrationFinish, () => requireMigrationManager().finish());

  registerTrustedQuery(IPC_CHANNELS.migrationCancel, () => requireMigrationManager().cancel());

  registerTrustedQuery(IPC_CHANNELS.migrationReopen, () => requireMigrationManager().reopen());

  registerTrustedQuery(IPC_CHANNELS.migrationDeleteStaged, () =>
    requireMigrationManager().deleteStagedPasswords()
  );

  // The read path that makes an import visible. Filtering happens here, so the
  // renderer never holds the whole store.
  registerTrustedHandler(IPC_CHANNELS.bookmarkSearch, parseBookmarkQueryPayload, (payload) =>
    requireMigrationManager().searchBookmarks(payload.query)
  );
}

/**
 * Opens whatever the desktop asked for, by the entrance that scheme deserves.
 *
 * A local document goes through `openLocalDocument`, which is the only path in
 * the browser that can reach `file:` at all - see the comment on that method for
 * why the distinction is the safety property rather than a formality.
 */
function openLaunchTarget(manager: BrowserManager, url: string): void {
  const paneId = manager.snapshot().activePaneId;
  if (isLocalDocumentUrl(url)) manager.openLocalDocument(paneId, url);
  else manager.createTab(paneId, url);
}

/** Brings the existing window forward and opens a requested link in it. */
function handleReactivation(argv: readonly string[]): void {
  const target = mainWindow;
  if (target === null || target.isDestroyed()) return;

  if (target.isMinimized()) target.restore();
  target.focus();

  const url = launchTargetFromCommandLine(argv);
  if (url !== null && browserManager !== null) openLaunchTarget(browserManager, url);
}

if (!hasSingleInstanceLock) {
  // Another instance owns the session. It has been handed our arguments and
  // will surface the request, so this process must exit without touching any
  // shared state.
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => handleReactivation(argv));

  void app.whenReady().then(() => {
    // Windows ships without the default File/Edit/View/Window menu while keeping
    // the native title-bar controls intact.
    if (process.platform === "win32") Menu.setApplicationMenu(null);

    denyAllPermissions(session.defaultSession);
    denyAllPermissions(session.fromPartition(PROFILE_PARTITION));

    registerIpcHandlers();
    createWindow();

    // After the window, and never awaited before it. Preparing the transport
    // only loads a module and subscribes to it - nothing is checked, fetched, or
    // installed until a person asks - so it must not delay the first paint.
    void prepareUpdateTransport();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // macOS delivers links through an event rather than on the command line.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (!isAllowedUrl(url)) return;
    if (browserManager === null) {
      pendingLaunchUrl = url;
      return;
    }
    browserManager.createTab(browserManager.snapshot().activePaneId, url);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
