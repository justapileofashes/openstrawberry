import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_STATE_EVENT,
  BROWSER_STATE_EVENT,
  IPC_CHANNELS,
  WINDOW_STATE_EVENT,
  type ShellInfo,
  type WindowState
} from "../shared/bridge.js";
import {
  parseCompanionIdPayload,
  parseCreateCompanionPayload,
  parseCredentialScopePayload,
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
  usesCustomWindowControls
} from "../shared/desktop-shell.js";
import {
  parseHtmlPickPayload,
  parseMigrationCommitPayload,
  parseMigrationHandlePayload,
  parseMigrationPreviewPayload
} from "../shared/migration.js";
import { isAllowedUrl, urlFromCommandLine } from "../shared/navigation.js";
import { BrowserManager } from "./browser-manager.js";
import { MigrationManager, type MigrationDialogPort } from "./migration-manager.js";
import { AgentManager, type BrowserPort } from "./agent-manager.js";
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
let agentManager: AgentManager | null = null;
let migrationManager: MigrationManager | null = null;
/** A link that arrived before the browser core existed. */
let pendingLaunchUrl: string | null = urlFromCommandLine(process.argv);

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
    contentsFor: (tabId) => manager.contentsFor(tabId)
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

  const browser = new BrowserManager({
    window,
    profile: session.fromPartition(PROFILE_PARTITION),
    sessionFilePath: join(app.getPath("userData"), "session.json"),
    publish: (snapshot: BrowserSnapshot) => sendToRenderer(BROWSER_STATE_EVENT, snapshot)
  });

  browserManager = browser;

  /*
   * The OS keychain, as the credential store needs it. `createOsCipher` owns the
   * judgement of when the platform's encryption is worth trusting — notably that
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

  agentManager = new AgentManager({
    statePath: join(app.getPath("userData"), "agents.json"),
    browser: browserPortFor(browser),
    secrets,
    publish: (snapshot: AgentSnapshot) => sendToRenderer(AGENT_STATE_EVENT, snapshot)
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
    const agents = agentManager;
    agentManager = null;
    agents?.destroy();

    const manager = browserManager;
    browserManager = null;
    manager?.destroy();
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

    // A link that launched the app opens alongside the restored session rather
    // than replacing it.
    const launchUrl = pendingLaunchUrl;
    pendingLaunchUrl = null;
    if (launchUrl !== null) manager.createTab(manager.snapshot().activePaneId, launchUrl);
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
   * A refusal to store — no OS encryption available — throws, and the chrome
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
   * Migration. Every channel below goes through the same router as everything
   * else, so each one verifies the sender is the chrome, validates the payload
   * with no coercion, and redacts any failure — which matters more here than
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

  registerTrustedHandler(IPC_CHANNELS.migrationCommit, parseMigrationCommitPayload, (payload) =>
    requireMigrationManager().commit(payload)
  );

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
}

/** Brings the existing window forward and opens a requested link in it. */
function handleReactivation(argv: readonly string[]): void {
  const target = mainWindow;
  if (target === null || target.isDestroyed()) return;

  if (target.isMinimized()) target.restore();
  target.focus();

  const url = urlFromCommandLine(argv);
  if (url !== null) browserManager?.createTab(browserManager.snapshot().activePaneId, url);
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
