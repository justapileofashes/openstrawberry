import { app, BrowserWindow, Menu, session, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_STATE_EVENT, IPC_CHANNELS, type ShellInfo } from "../shared/bridge.js";
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
import { APP_ID, PROFILE_PARTITION, RELEASE_READY } from "../shared/desktop-shell.js";
import { isAllowedUrl, urlFromCommandLine } from "../shared/navigation.js";
import { BrowserManager } from "./browser-manager.js";
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
    // macOS keeps its native inset controls; Windows and Linux keep the standard
    // system title bar, so only the application menu is removed below.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
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

  browserManager = new BrowserManager({
    window,
    profile: session.fromPartition(PROFILE_PARTITION),
    sessionFilePath: join(app.getPath("userData"), "session.json"),
    publish: (snapshot: BrowserSnapshot) => sendToRenderer(BROWSER_STATE_EVENT, snapshot)
  });

  window.once("ready-to-show", () => window.show());

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
