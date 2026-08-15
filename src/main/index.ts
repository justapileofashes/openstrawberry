/* OpenStrawberry main process: native browser views and a minimal trusted IPC surface. */
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { BrowserManager } from "./browser-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { ProviderRunner } from "./provider-runner.js";
import { CliRunner } from "./cli-runner.js";
import { MigrationManager } from "./migration-manager.js";
import { createOrchestrationPlan } from "./orchestrator.js";
import { DESKTOP_APP_ID, DESKTOP_APP_NAME } from "../shared/desktop-shell.js";
import { parseAgentProfileInput, parseAgentRunRequest, parseMediaCommand, parseOrchestrationRequest, parseViewport, requireBoolean, requireBrowserId, requireCommand, requireIdentifier, requirePane, requireString } from "../shared/ipc-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let agentRegistry: AgentRegistry | null = null;
let providerRunner: ProviderRunner | null = null;
let cliRunner: CliRunner | null = null;
let migrationManager: MigrationManager | null = null;

app.enableSandbox();
app.setName(DESKTOP_APP_NAME);
app.setAppUserModelId(DESKTOP_APP_ID);

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Rejected IPC request from an untrusted renderer.");
}
function registerTrustedHandler(channel: string, handler: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => { assertTrustedRenderer(event); return handler(...args); });
}

function createWindow(): void {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  const rendererUrl = devUrl ?? pathToFileURL(join(__dirname, "../renderer/index.html")).toString();
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 1024, minHeight: 700, backgroundColor: "#050506", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default", webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, allowRunningInsecureContent: false } });
  browserManager = new BrowserManager(mainWindow, (snapshot) => mainWindow?.webContents.send("browser:state", snapshot), join(app.getPath("userData"), "window-session.json"), join(app.getPath("userData"), "workspace-snapshots.json"));
  const isTrustedRendererUrl = (url: string) => { try { return devUrl ? new URL(url).origin === new URL(rendererUrl).origin : url === rendererUrl; } catch { return false; } };
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!isTrustedRendererUrl(url)) event.preventDefault(); });
  void mainWindow.loadURL(rendererUrl);
  mainWindow.on("closed", () => { browserManager?.destroy(); browserManager = null; mainWindow = null; });
}
app.whenReady().then(() => { session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); agentRegistry = new AgentRegistry(join(app.getPath("userData"), "agents.json"), join(app.getPath("userData"), "agent-vault.json")); providerRunner = new ProviderRunner(agentRegistry); cliRunner = new CliRunner(agentRegistry, join(app.getPath("userData"), "agent-workspaces")); migrationManager = new MigrationManager(app.getPath("userData")); createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
registerTrustedHandler("browser:ready", () => browserManager?.initialize());
registerTrustedHandler("browser:create", (input, paneId) => browserManager?.createTab(input, paneId === undefined ? undefined : requirePane(paneId)));
registerTrustedHandler("browser:activate", (id, paneId) => browserManager?.activateTab(requireIdentifier(id, "Tab ID"), paneId === undefined ? undefined : requirePane(paneId)));
registerTrustedHandler("browser:close", (id) => browserManager?.closeTab(requireIdentifier(id, "Tab ID")));
registerTrustedHandler("browser:navigate", (id, input) => browserManager?.navigate(requireIdentifier(id, "Tab ID"), input));
registerTrustedHandler("browser:command", (id, command) => browserManager?.command(requireIdentifier(id, "Tab ID"), requireCommand(command)));
registerTrustedHandler("browser:set-viewport", (viewport) => browserManager?.setViewport(parseViewport(viewport)));
registerTrustedHandler("browser:set-split", (enabled) => browserManager?.setSplit(requireBoolean(enabled, "Split state")));
registerTrustedHandler("browser:set-active-pane", (paneId) => browserManager?.setActivePane(requirePane(paneId)));
registerTrustedHandler("app:version", () => app.getVersion());
registerTrustedHandler("workspace:list", () => browserManager?.listWorkspaceSnapshots() ?? []);
registerTrustedHandler("workspace:save", (name) => browserManager?.saveWorkspaceSnapshot(requireString(name, "Workspace name", 80)));
registerTrustedHandler("workspace:restore", (id) => browserManager?.restoreWorkspaceSnapshot(requireIdentifier(id, "Workspace ID")));
registerTrustedHandler("browser:reveal-download", (id) => browserManager?.revealDownload(requireIdentifier(id, "Download ID")) ?? false);
registerTrustedHandler("media:state", () => browserManager?.mediaState());
registerTrustedHandler("media:command", (command) => browserManager?.mediaCommand(parseMediaCommand(command)));
registerTrustedHandler("browser:toggle-reader", () => browserManager?.toggleReaderMode() ?? false);
registerTrustedHandler("agents:list", () => agentRegistry?.list() ?? []);
registerTrustedHandler("agents:save", (input) => agentRegistry?.save(parseAgentProfileInput(input)));
registerTrustedHandler("agents:detect-local-clis", () => agentRegistry?.detectLocalClis() ?? []);
registerTrustedHandler("orchestrator:create-plan", (request) => createOrchestrationPlan(parseOrchestrationRequest(request)));
registerTrustedHandler("agents:run-provider", async (rawRequest) => {
  const request = parseAgentRunRequest(rawRequest);
  const profile = agentRegistry?.list().find((agent) => agent.id === request.agentId);
  if (!profile || !providerRunner) throw new Error("The requested agent is unavailable.");
  const contextUrls = browserManager?.selectedContextUrls() ?? [];
  const approvalOptions = { type: "warning" as const, buttons: ["Cancel", "Run agent"], defaultId: 0, cancelId: 0, title: "Approve provider run", message: `Send a task to ${profile.name}?`, detail: `${profile.provider} / ${profile.model} will receive your task and ${contextUrls.length} selected browser URL reference(s). Its own local credential binding will be used. Browser page contents and credentials are not sent automatically.` };
  const response = mainWindow ? await dialog.showMessageBox(mainWindow, approvalOptions) : await dialog.showMessageBox(approvalOptions);
  if (response.response !== 1) return { agentId: request.agentId, provider: profile.provider, model: profile.model, text: "", startedAt: Date.now(), completedAt: Date.now(), status: "failed" as const, error: "Run cancelled by the user." };
  return providerRunner.run({ ...request, context: { selectedTabUrls: contextUrls } });
});
registerTrustedHandler("agents:run-cli", async (rawRequest) => {
  const request = parseAgentRunRequest(rawRequest);
  const profile = agentRegistry?.list().find((agent) => agent.id === request.agentId);
  if (!profile || !cliRunner) throw new Error("The requested agent is unavailable.");
  const contextUrls = browserManager?.selectedContextUrls() ?? [];
  const approvalOptions = { type: "warning" as const, buttons: ["Cancel", "Run local CLI"], defaultId: 0, cancelId: 0, title: "Approve local CLI run", message: `Run ${profile.name} through ${profile.provider}?`, detail: `The installed local CLI will receive your task and ${contextUrls.length} selected browser URL reference(s). It starts in an OpenStrawberry-owned agent workspace, has no shell invocation from OpenStrawberry, and will be stopped after 120 seconds. Its local credential binding will be used without being returned to the interface.` };
  const response = mainWindow ? await dialog.showMessageBox(mainWindow, approvalOptions) : await dialog.showMessageBox(approvalOptions);
  if (response.response !== 1) return { agentId: request.agentId, provider: profile.provider, model: profile.model, text: "", startedAt: Date.now(), completedAt: Date.now(), status: "failed" as const, error: "Run cancelled by the user." };
  return cliRunner.run({ ...request, context: { selectedTabUrls: contextUrls } });
});
registerTrustedHandler("migration:state", () => migrationManager?.getOnboardingState() ?? { completed: true });
registerTrustedHandler("migration:detect", () => migrationManager?.detectBrowsers() ?? []);
registerTrustedHandler("migration:import", async (rawBrowserId) => {
  const browserId = requireBrowserId(rawBrowserId);
  if (!migrationManager) throw new Error("Migration is unavailable until OpenStrawberry has finished starting.");
  const source = migrationManager.detectBrowsers().find((browser) => browser.id === browserId);
  if (!source?.detected) throw new Error("That browser profile is not available on this device.");
  const approvalOptions = { type: "warning" as const, buttons: ["Cancel", "Import bookmarks"], defaultId: 0, cancelId: 0, title: "Approve browser migration", message: `Import from ${source.label}?`, detail: "OpenStrawberry will read compatible bookmark data and the displayed default-search name from the selected local browser profile. It will not copy passwords, cookies, sessions, payment data, account tokens, or history." };
  const response = mainWindow ? await dialog.showMessageBox(mainWindow, approvalOptions) : await dialog.showMessageBox(approvalOptions);
  if (response.response !== 1) throw new Error("Migration cancelled by the user.");
  return migrationManager.importBrowser(browserId);
});
registerTrustedHandler("migration:complete", (rawBrowserId) => migrationManager?.completeOnboarding(rawBrowserId === undefined ? undefined : requireBrowserId(rawBrowserId)) ?? { completed: true });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
