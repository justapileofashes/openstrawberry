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
});
