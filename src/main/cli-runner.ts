/* Local coding-CLI runner: strict executable allowlist, no shell, bounded output/time, and per-agent app-owned workspace directories. */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentRegistry } from "./agent-registry.js";
import type { AgentRunRequest, AgentRunResult } from "../shared/agent-run.js";
import { buildContextualPrompt } from "../shared/provider-protocol.js";
import { buildCliInvocation, resolveSupportedCli } from "../shared/cli-protocol.js";

const CLI_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export class CliRunner {
  public constructor(private readonly registry: AgentRegistry, private readonly workspaceRoot: string) {}

  public async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    try {
      const { profile, apiKey } = this.registry.resolveCliCredential(request.agentId);
      const command = resolveSupportedCli(profile);
      const prompt = buildContextualPrompt(request.prompt, request.context.selectedTabUrls, request.context.artifactText);
      const invocation = buildCliInvocation(command, prompt);
      const workspace = join(this.workspaceRoot, profile.id.replace(/[^a-zA-Z0-9_-]/g, "_"));
      mkdirSync(workspace, { recursive: true });
      const env = { ...process.env, ...(invocation.credentialEnv ? { [invocation.credentialEnv]: apiKey } : {}) };
      const text = await this.spawnBounded(invocation.command, invocation.args, workspace, env, apiKey);
      return { agentId: profile.id, provider: profile.provider, model: profile.model, text, startedAt, completedAt: Date.now(), status: "completed" };
    } catch (error) {
      return { agentId: request.agentId, provider: "redacted", model: "redacted", text: "", startedAt, completedAt: Date.now(), status: "failed", error: error instanceof Error ? error.message : "Local CLI run failed." };
    }
  }

  private spawnBounded(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, apiKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
      let didTruncate = false;
      const append = (chunk: Buffer) => {
        if (output.length >= MAX_OUTPUT_BYTES) { didTruncate = true; return; }
        output += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES - output.length);
      };
      const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => child.kill("SIGTERM"), CLI_TIMEOUT_MS);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        const redacted = output.replaceAll(apiKey, "[redacted credential]");
        if (signal === "SIGTERM") { reject(new Error("The local CLI run exceeded the 120-second limit and was stopped.")); return; }
        if (code !== 0) { reject(new Error(`The local CLI exited with code ${code ?? "unknown"}. ${redacted.slice(-1200)}`)); return; }
        resolve(`${redacted}${didTruncate ? "\n\n[Output truncated at 1 MB.]" : ""}`.trim() || "The local CLI completed without emitting output.");
      });
    });
  }
}
