import type { AgentProfileSummary } from "./agent.js";

export type SupportedCli = "codex" | "claude" | "opencode";
export type CliInvocation = { command: SupportedCli; args: string[]; credentialEnv?: "CODEX_API_KEY" | "ANTHROPIC_API_KEY" };

export function resolveSupportedCli(profile: AgentProfileSummary): SupportedCli {
  const normalized = profile.provider.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "codex") return "codex";
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "opencode") return "opencode";
  throw new Error("Only Codex, Claude Code, and OpenCode have supported non-interactive execution adapters at this time.");
}

export function buildCliInvocation(command: SupportedCli, prompt: string): CliInvocation {
  if (command === "codex") return { command, args: ["exec", "--sandbox", "workspace-write", "--json", prompt], credentialEnv: "CODEX_API_KEY" };
  if (command === "claude") return { command, args: ["--bare", "-p", prompt, "--allowedTools", "Read,Edit", "--output-format", "stream-json"], credentialEnv: "ANTHROPIC_API_KEY" };
  return { command, args: ["run", prompt, "--format", "json"] };
}
