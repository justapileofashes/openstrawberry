import type { AgentProfileInput, AgentRole } from "./agent.js";
import type { AgentRunRequest } from "./agent-run.js";
import type { BrowserCommand, BrowserPaneId, BrowserViewport } from "./browser.js";
import type { MediaCommand } from "./media.js";
import type { BrowserId } from "./migration.js";
import type { OrchestrationRequest } from "./orchestration.js";

const MAX_SHORT_TEXT = 200;
const MAX_SECRET_LENGTH = 8_192;
const ROLES = new Set<AgentRole>(["companion", "orchestrator", "researcher", "coder", "reviewer"]);
const EXECUTORS = new Set(["provider", "local-cli"]);
const PANES = new Set<BrowserPaneId>(["primary", "secondary"]);
const COMMANDS = new Set<BrowserCommand>(["back", "forward", "reload", "stop"]);
const BROWSERS = new Set<BrowserId>(["chrome", "edge", "brave", "firefox", "safari"]);
const MEDIA_ACTIONS = new Set<MediaCommand["action"]>(["refresh", "play", "pause", "toggle", "seek", "volume", "mute", "picture-in-picture"]);

export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function requireString(value: unknown, label: string, maxLength = MAX_SHORT_TEXT): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} is too long.`);
  return normalized;
}
export function requireOptionalString(value: unknown, label: string, maxLength = MAX_SHORT_TEXT): string | undefined { return value === undefined || value === "" ? undefined : requireString(value, label, maxLength); }
export function requireIdentifier(value: unknown, label = "Identifier"): string { return requireString(value, label, 128).replace(/[^a-zA-Z0-9_-]/g, "") || (() => { throw new Error(`${label} is invalid.`); })(); }
export function requirePane(value: unknown): BrowserPaneId { if (typeof value === "string" && PANES.has(value as BrowserPaneId)) return value as BrowserPaneId; throw new Error("Unsupported browser pane."); }
export function requireCommand(value: unknown): BrowserCommand { if (typeof value === "string" && COMMANDS.has(value as BrowserCommand)) return value as BrowserCommand; throw new Error("Unsupported browser command."); }
export function requireBoolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`); return value; }
export function requireBrowserId(value: unknown): BrowserId { if (typeof value === "string" && BROWSERS.has(value as BrowserId)) return value as BrowserId; throw new Error("Unsupported browser source."); }
export function parseViewport(value: unknown): BrowserViewport {
  if (!isRecord(value)) throw new Error("Viewport must be an object.");
  const paneId = requirePane(value.paneId);
  const number = (input: unknown, label: string) => { if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 100_000) throw new Error(`${label} is invalid.`); return Math.round(input); };
  return { paneId, x: number(value.x, "Viewport x"), y: number(value.y, "Viewport y"), width: number(value.width, "Viewport width"), height: number(value.height, "Viewport height") };
}
export function parseMediaCommand(value: unknown): MediaCommand {
  if (!isRecord(value) || typeof value.action !== "string" || !MEDIA_ACTIONS.has(value.action as MediaCommand["action"])) throw new Error("Unsupported media command.");
  if (value.action === "seek") { if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0 || value.value > 31_536_000) throw new Error("Invalid media seek value."); return { action: "seek", value: value.value }; }
  if (value.action === "volume") { if (typeof value.value !== "number" || !Number.isFinite(value.value) || value.value < 0 || value.value > 1) throw new Error("Invalid media volume value."); return { action: "volume", value: value.value }; }
  return { action: value.action as Exclude<MediaCommand["action"], "seek" | "volume"> } as MediaCommand;
}
export function parseAgentProfileInput(value: unknown): AgentProfileInput {
  if (!isRecord(value) || typeof value.role !== "string" || !ROLES.has(value.role as AgentRole) || typeof value.executor !== "string" || !EXECUTORS.has(value.executor)) throw new Error("Invalid agent profile.");
  const apiKey = requireOptionalString(value.apiKey, "Credential", MAX_SECRET_LENGTH);
  if (value.clearCredential !== undefined && typeof value.clearCredential !== "boolean") throw new Error("Invalid credential clearing option.");
  return { id: requireOptionalString(value.id, "Agent ID", 128), name: requireString(value.name, "Agent name", 80), role: value.role as AgentRole, provider: requireString(value.provider, "Provider", 120), model: requireString(value.model, "Model", 160), baseUrl: requireOptionalString(value.baseUrl, "Base URL", 2_048), executor: value.executor as AgentProfileInput["executor"], apiKey, clearCredential: value.clearCredential === true };
}
export function parseAgentRunRequest(value: unknown): Omit<AgentRunRequest, "context"> {
  if (!isRecord(value)) throw new Error("Agent run request must be an object.");
  return { agentId: requireIdentifier(value.agentId, "Agent ID"), prompt: requireString(value.prompt, "Agent task", 24_000) };
}
export function parseOrchestrationRequest(value: unknown): OrchestrationRequest {
  if (!isRecord(value) || !Array.isArray(value.availableRoles) || value.availableRoles.length > ROLES.size || !value.availableRoles.every((role) => typeof role === "string" && ROLES.has(role as AgentRole))) throw new Error("Invalid orchestration request.");
  if (typeof value.sourceTabCount !== "number" || !Number.isInteger(value.sourceTabCount) || value.sourceTabCount < 0 || value.sourceTabCount > 50) throw new Error("Invalid source tab count.");
  return { objective: requireString(value.objective, "Orchestration objective", 4_000), sourceTabCount: value.sourceTabCount, availableRoles: value.availableRoles as AgentRole[] };
}
