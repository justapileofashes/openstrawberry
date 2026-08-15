import { describe, expect, it } from "vitest";
import { buildCliInvocation, resolveSupportedCli } from "./cli-protocol.js";

const profile = { id: "coder", name: "Coder", role: "coder" as const, provider: "Codex", model: "local", baseUrl: "", credentialStatus: "ready" as const, executor: "local-cli" as const };

describe("local CLI invocation contract", () => {
  it("uses Codex exec without a shell and keeps workspace-write explicit", () => {
    expect(resolveSupportedCli(profile)).toBe("codex");
    expect(buildCliInvocation("codex", "Audit this workspace")).toEqual({ command: "codex", args: ["exec", "--sandbox", "workspace-write", "--json", "Audit this workspace"], credentialEnv: "CODEX_API_KEY" });
  });

  it("uses Claude’s documented non-interactive stream-json output", () => {
    expect(buildCliInvocation("claude", "Review changes")).toEqual({ command: "claude", args: ["--bare", "-p", "Review changes", "--allowedTools", "Read,Edit", "--output-format", "stream-json"], credentialEnv: "ANTHROPIC_API_KEY" });
  });

  it("uses Qwen Code’s bounded non-interactive mode with an ephemeral OpenAI-compatible credential", () => {
    const qwen = { ...profile, provider: "Qwen Code", model: "qwen3-coder-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/" };
    expect(resolveSupportedCli(qwen)).toBe("qwen");
    expect(buildCliInvocation("qwen", "Review changes", qwen)).toEqual({
      command: "qwen",
      args: ["--auth-type", "openai", "--model", "qwen3-coder-plus", "--openai-base-url", "https://dashscope.aliyuncs.com/compatible-mode/v1", "--approval-mode", "auto-edit", "--prompt", "Review changes", "--output-format", "json"],
      credentialEnv: "OPENAI_API_KEY",
      environment: { QWEN_CODE_NO_RELAUNCH: "1", NO_COLOR: "1" },
    });
  });

  it("uses Kimi Code’s non-interactive stream JSON mode with per-run model credentials", () => {
    const kimi = { ...profile, provider: "Kimi Code", model: "kimi-for-coding", baseUrl: "" };
    expect(resolveSupportedCli(kimi)).toBe("kimi");
    expect(buildCliInvocation("kimi", "Review changes", kimi)).toEqual({
      command: "kimi",
      args: ["--prompt", "Review changes", "--output-format", "stream-json", "--max-steps-per-turn", "8"],
      credentialEnv: "KIMI_MODEL_API_KEY",
      environment: {
        KIMI_MODEL_NAME: "kimi-for-coding",
        KIMI_MODEL_PROVIDER_TYPE: "kimi",
        KIMI_MODEL_BASE_URL: "https://api.kimi.com/coding/v1",
        KIMI_DISABLE_TELEMETRY: "1",
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_DISABLE_CRON: "1",
        NO_COLOR: "1",
      },
    });
  });

  it("rejects a non-HTTPS Qwen endpoint instead of passing it to the CLI", () => {
    expect(() => buildCliInvocation("qwen", "Review changes", { ...profile, model: "qwen3-coder-plus", baseUrl: "http://localhost:11434/v1" })).toThrow("HTTPS");
  });
});
