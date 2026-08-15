import { describe, expect, it } from "vitest";
import { CliRunner, createRestrictedCliEnvironment } from "./cli-runner.js";

describe("CLI runner environment boundary", () => {
  it("passes only an allowlisted environment and the requested credential variable", () => {
    const environment = createRestrictedCliEnvironment("CODEX_API_KEY", "agent-key", {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      AWS_SECRET_ACCESS_KEY: "must-not-pass",
      GITHUB_TOKEN: "must-not-pass",
    });

    expect(environment).toEqual({ PATH: "/safe/bin", HOME: "/safe/home", CODEX_API_KEY: "agent-key" });
  });

  it("does not introduce a credential variable for credential-less invocations", () => {
    expect(createRestrictedCliEnvironment(undefined, "unused", { PATH: "/safe/bin" })).toEqual({ PATH: "/safe/bin" });
  });

  it("fails closed with a redacted result when an allowlisted executable is unavailable", async () => {
    const registry = {
      resolveCliCredential: () => ({
        profile: { id: "coder-1", name: "Coder", role: "coder", provider: "codex", model: "gpt-test", baseUrl: "", executor: "local-cli", credentialStatus: "ready" as const },
        apiKey: "private-cli-key",
      }),
      resolveCliExecutable: () => null,
    };
    const runner = new CliRunner(registry as never, "/tmp/openstrawberry-cli-test");

    const result = await runner.run({ agentId: "coder-1", prompt: "Inspect this project.", context: { selectedTabUrls: [] } });

    expect(result).toMatchObject({ status: "failed", provider: "redacted", model: "redacted" });
    expect(result.error).toContain("was not found");
    expect(result.error).not.toContain("private-cli-key");
  });
});
