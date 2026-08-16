import { app, BrowserWindow, Menu, session, shell } from "electron";
import { join } from "node:path";
import { IPC_CHANNELS, type ShellInfo } from "../shared/bridge.js";
import { APP_ID, PROFILE_PARTITION, RELEASE_READY } from "../shared/desktop-shell.js";
import { buildAllowedUrlPrefixes } from "./ipc-security.js";
import { registerTrustedQuery, setTrustedRendererPolicy } from "./ipc-router.js";

// Guest web content must never inherit Node. Enabling the sandbox before the
// app is ready applies it to every renderer the process later creates.
app.enableSandbox();
app.setAppUserModelId(APP_ID);

const DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];

let mainWindow: BrowserWindow | null = null;

function denyAllPermissions(target: Electron.Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

function createWindow(): void {
  const window = new BrowserWindow({
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

  window.once("ready-to-show", () => window.show());

  // The chrome itself must never navigate away or spawn native windows. Any
  // external link is handed to the operating system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event) => event.preventDefault());

  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
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
}

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
