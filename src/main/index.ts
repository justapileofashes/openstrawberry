/* OpenStrawberry main process: native browser views and a minimal trusted IPC surface. */
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BrowserManager } from "./browser-manager.js";
import { AgentRegistry } from "./agent-registry.js";
import { ProviderRunner } from "./provider-runner.js";
import { CliRunner } from "./cli-runner.js";
import { createOrchestrationPlan } from "./orchestrator.js";
import type { BrowserCommand, BrowserViewport } from "../shared/browser.js";
import type { AgentProfileInput } from "../shared/agent.js";
import type { MediaCommand } from "../shared/media.js";
import type { OrchestrationRequest } from "../shared/orchestration.js";
import type { AgentRunRequest } from "../shared/agent-run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let browserManager: BrowserManager | null = null;
let agentRegistry: AgentRegistry | null = null;
let providerRunner: ProviderRunner | null = null;
let cliRunner: CliRunner | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 1024, minHeight: 700, backgroundColor: "#050506", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default", webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  browserManager = new BrowserManager(mainWindow, (snapshot) => mainWindow?.webContents.send("browser:state", snapshot), join(app.getPath("userData"), "window-session.json"));
  const devUrl = process.env.VITE_DEV_SERVER_URL; if (devUrl) void mainWindow.loadURL(devUrl); else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.on("closed", () => { browserManager?.destroy(); browserManager = null; mainWindow = null; });
}
app.whenReady().then(() => { session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); agentRegistry = new AgentRegistry(join(app.getPath("userData"), "agents.json"), join(app.getPath("userData"), "agent-vault.json")); providerRunner = new ProviderRunner(agentRegistry); cliRunner = new CliRunner(agentRegistry, join(app.getPath("userData"), "agent-workspaces")); createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
ipcMain.handle("browser:ready", () => browserManager?.initialize()); ipcMain.handle("browser:create", (_event, input?: string, paneId?: "primary" | "secondary") => browserManager?.createTab(input, paneId)); ipcMain.handle("browser:activate", (_event, id: string, paneId?: "primary" | "secondary") => browserManager?.activateTab(id, paneId)); ipcMain.handle("browser:close", (_event, id: string) => browserManager?.closeTab(id)); ipcMain.handle("browser:navigate", (_event, id: string, input: string) => browserManager?.navigate(id, input)); ipcMain.handle("browser:command", (_event, id: string, command: BrowserCommand) => browserManager?.command(id, command)); ipcMain.handle("browser:set-viewport", (_event, viewport: BrowserViewport) => browserManager?.setViewport(viewport)); ipcMain.handle("browser:set-split", (_event, enabled: boolean) => browserManager?.setSplit(enabled)); ipcMain.handle("browser:set-active-pane", (_event, paneId: "primary" | "secondary") => browserManager?.setActivePane(paneId)); ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("media:state", () => browserManager?.mediaState());
ipcMain.handle("media:command", (_event, command: MediaCommand) => browserManager?.mediaCommand(command));
ipcMain.handle("agents:list", () => agentRegistry?.list() ?? []);
ipcMain.handle("agents:save", (_event, input: AgentProfileInput) => agentRegistry?.save(input));
ipcMain.handle("agents:detect-local-clis", () => agentRegistry?.detectLocalClis() ?? []);
ipcMain.handle("orchestrator:create-plan", (_event, request: OrchestrationRequest) => createOrchestrationPlan(request));
ipcMain.handle("agents:run-provider", async (_event, request: Omit<AgentRunRequest, "context">) => {
  const profile = agentRegistry?.list().find((agent) => agent.id === request.agentId);
  if (!profile || !providerRunner) throw new Error("The requested agent is unavailable.");
  const contextUrls = browserManager?.selectedContextUrls() ?? [];
  const approvalOptions = { type: "warning" as const, buttons: ["Cancel", "Run agent"], defaultId: 0, cancelId: 0, title: "Approve provider run", message: `Send a task to ${profile.name}?`, detail: `${profile.provider} / ${profile.model} will receive your task and ${contextUrls.length} selected browser URL reference(s). Its own local credential binding will be used. Browser page contents and credentials are not sent automatically.` };
  const response = mainWindow ? await dialog.showMessageBox(mainWindow, approvalOptions) : await dialog.showMessageBox(approvalOptions);
  if (response.response !== 1) return { agentId: request.agentId, provider: profile.provider, model: profile.model, text: "", startedAt: Date.now(), completedAt: Date.now(), status: "failed" as const, error: "Run cancelled by the user." };
  return providerRunner.run({ ...request, context: { selectedTabUrls: contextUrls } });
});
ipcMain.handle("agents:run-cli", async (_event, request: Omit<AgentRunRequest, "context">) => {
  const profile = agentRegistry?.list().find((agent) => agent.id === request.agentId);
  if (!profile || !cliRunner) throw new Error("The requested agent is unavailable.");
  const contextUrls = browserManager?.selectedContextUrls() ?? [];
  const approvalOptions = { type: "warning" as const, buttons: ["Cancel", "Run local CLI"], defaultId: 0, cancelId: 0, title: "Approve local CLI run", message: `Run ${profile.name} through ${profile.provider}?`, detail: `The installed local CLI will receive your task and ${contextUrls.length} selected browser URL reference(s). It starts in an OpenStrawberry-owned agent workspace, has no shell invocation from OpenStrawberry, and will be stopped after 120 seconds. Its local credential binding will be used without being returned to the interface.` };
  const response = mainWindow ? await dialog.showMessageBox(mainWindow, approvalOptions) : await dialog.showMessageBox(approvalOptions);
  if (response.response !== 1) return { agentId: request.agentId, provider: profile.provider, model: profile.model, text: "", startedAt: Date.now(), completedAt: Date.now(), status: "failed" as const, error: "Run cancelled by the user." };
  return cliRunner.run({ ...request, context: { selectedTabUrls: contextUrls } });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
