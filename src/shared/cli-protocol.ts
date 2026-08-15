import type { AgentProfileSummary } from "./agent.js";

export type SupportedCli = "codex" | "claude" | "qwen" | "kimi" | "opencode";
export type CliInvocation = {
  command: SupportedCli;
  args: string[];
  credentialEnv?: "CODEX_API_KEY" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "KIMI_MODEL_API_KEY";
  environment?: Record<string, string>;
};
type CliProfile = Pick<AgentProfileSummary, "model" | "baseUrl">;

export function resolveSupportedCli(profile: AgentProfileSummary): SupportedCli {
  const normalized = profile.provider.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "codex") return "codex";
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "qwen" || normalized === "qwen-code") return "qwen";
  if (normalized === "kimi" || normalized === "kimi-code") return "kimi";
  if (normalized === "opencode") return "opencode";
  throw new Error("Only Codex, Claude Code, Qwen Code, Kimi Code, and OpenCode have supported non-interactive execution adapters at this time.");
}

export function buildCliInvocation(command: SupportedCli, prompt: string, profile?: CliProfile): CliInvocation {
  if (command === "codex") return { command, args: ["exec", "--sandbox", "workspace-write", "--json", prompt], credentialEnv: "CODEX_API_KEY" };
  if (command === "claude") return { command, args: ["--bare", "-p", prompt, "--allowedTools", "Read,Edit", "--output-format", "stream-json"], credentialEnv: "ANTHROPIC_API_KEY" };
  if (command === "qwen") {
    const endpoint = requireHttpsEndpoint(profile?.baseUrl, "Qwen Code");
    const model = requireModel(profile?.model, "Qwen Code");
    return {
      command,
      args: ["--auth-type", "openai", "--model", model, "--openai-base-url", endpoint, "--approval-mode", "auto-edit", "--prompt", prompt, "--output-format", "json"],
      credentialEnv: "OPENAI_API_KEY",
      environment: { QWEN_CODE_NO_RELAUNCH: "1", NO_COLOR: "1" },
    };
  }
  if (command === "kimi") {
    const model = requireModel(profile?.model, "Kimi Code");
    const endpoint = optionalHttpsEndpoint(profile?.baseUrl, "Kimi Code") ?? "https://api.kimi.com/coding/v1";
    return {
      command,
      // Kimi's documented -p mode is non-interactive and cannot be combined with plan mode. The native approval gate therefore covers the entire bounded invocation.
      args: ["--prompt", prompt, "--output-format", "stream-json", "--max-steps-per-turn", "8"],
      credentialEnv: "KIMI_MODEL_API_KEY",
      environment: {
        KIMI_MODEL_NAME: model,
        KIMI_MODEL_PROVIDER_TYPE: "kimi",
        KIMI_MODEL_BASE_URL: endpoint,
        KIMI_DISABLE_TELEMETRY: "1",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_DISABLE_CRON: "1",
        NO_COLOR: "1",
      },
    };
  }
  return { command, args: ["run", prompt, "--format", "json"] };
}

function requireModel(model: string | undefined, cliName: string): string {
  const normalized = model?.trim();
  if (!normalized || normalized === "Select a CLI or provider" || normalized === "Select a provider") throw new Error(`${cliName} requires a model name in the agent profile.`);
  return normalized;
}

function requireHttpsEndpoint(value: string | undefined, cliName: string): string {
  const endpoint = optionalHttpsEndpoint(value, cliName);
  if (!endpoint) throw new Error(`${cliName} requires an HTTPS OpenAI-compatible base URL in the agent profile.`);
  return endpoint;
}

function optionalHttpsEndpoint(value: string | undefined, cliName: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${cliName} requires a valid HTTPS base URL when one is supplied.`);
  }
}
