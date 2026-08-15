/* OpenStrawberry agent registry: profile metadata is local; per-agent keys stay encrypted in the main process. */
import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { defaultAgentProfiles, type AgentProfileInput, type AgentProfileSummary, type AgentRole, type LocalCliStatus } from "../shared/agent.js";

type StoredVault = Record<string, string>;
const ROLES: AgentRole[] = ["companion", "orchestrator", "researcher", "coder", "reviewer"];
const CLI_CANDIDATES = [
  { command: "codex", label: "Codex" },
  { command: "claude", label: "Claude Code" },
  { command: "qwen", label: "Qwen Code" },
  { command: "kimi", label: "Kimi Code" },
  { command: "opencode", label: "OpenCode" }
];

export class AgentRegistry {
  private profiles = new Map<string, AgentProfileSummary>();
  private encryptedVault: StoredVault = {};

  public constructor(private readonly profileFile: string, private readonly vaultFile: string) { this.load(); }

  public list(): AgentProfileSummary[] { return [...this.profiles.values()]; }

  public save(input: AgentProfileInput): AgentProfileSummary {
    if (!ROLES.includes(input.role)) throw new Error("Unsupported agent role.");
    const name = input.name.trim();
    const provider = input.provider.trim();
    const model = input.model.trim();
    if (!name || !provider || !model) throw new Error("Name, provider, and model are required.");
    const id = input.id && this.profiles.has(input.id) ? input.id : `${input.role}-${randomUUID().slice(0, 8)}`;
    const existing = this.profiles.get(id);
    const profile: AgentProfileSummary = {
      id,
      name,
      role: input.role,
      provider,
      model,
      baseUrl: input.baseUrl?.trim() ?? "",
      executor: input.executor,
      credentialStatus: existing?.credentialStatus ?? "not-configured"
    };
    if (input.clearCredential) {
      delete this.encryptedVault[id];
      profile.credentialStatus = "not-configured";
    }
    if (input.apiKey?.trim()) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure operating-system encryption is unavailable, so OpenStrawberry will not store this key.");
      this.encryptedVault[id] = safeStorage.encryptString(input.apiKey.trim()).toString("base64");
      profile.credentialStatus = "ready";
    }
    this.profiles.set(id, profile);
    this.persist();
    return profile;
  }

  public detectLocalClis(): LocalCliStatus[] {
    const locator = process.platform === "win32" ? "where" : "which";
    return CLI_CANDIDATES.map((candidate) => {
      const result = spawnSync(locator, [candidate.command], { encoding: "utf8", windowsHide: true });
      const path = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
      return { ...candidate, available: Boolean(path), path };
    });
  }

  private load(): void {
    try {
      const stored = existsSync(this.profileFile) ? JSON.parse(readFileSync(this.profileFile, "utf8")) as AgentProfileSummary[] : defaultAgentProfiles;
      for (const profile of stored) this.profiles.set(profile.id, profile);
      if (existsSync(this.vaultFile)) this.encryptedVault = JSON.parse(readFileSync(this.vaultFile, "utf8")) as StoredVault;
      for (const profile of this.profiles.values()) if (this.encryptedVault[profile.id]) profile.credentialStatus = safeStorage.isEncryptionAvailable() ? "ready" : "unavailable";
    } catch {
      this.profiles = new Map(defaultAgentProfiles.map((profile) => [profile.id, profile]));
      this.encryptedVault = {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.profileFile), { recursive: true });
    writeFileSync(this.profileFile, JSON.stringify(this.list(), null, 2), "utf8");
    writeFileSync(this.vaultFile, JSON.stringify(this.encryptedVault, null, 2), "utf8");
  }
}
