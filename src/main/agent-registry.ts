/* OpenStrawberry agent registry: profile metadata is local; per-agent keys stay encrypted in the main process. */
import { safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
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
  public resolveProviderCredential(id: string): { profile: AgentProfileSummary; apiKey: string } {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error("The requested agent profile does not exist.");
    if (profile.executor !== "provider") throw new Error("This profile is configured for a local CLI rather than a provider API.");
    const encrypted = this.encryptedVault[id];
    if (!encrypted || profile.credentialStatus !== "ready") throw new Error("Configure a local API key for this agent before running it.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure operating-system encryption is unavailable, so this credential cannot be used.");
    return { profile, apiKey: safeStorage.decryptString(Buffer.from(encrypted, "base64")) };
  }
  public resolveCliCredential(id: string): { profile: AgentProfileSummary; apiKey: string } {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error("The requested agent profile does not exist.");
    if (profile.executor !== "local-cli") throw new Error("This profile is configured for a provider API rather than a local CLI.");
    const encrypted = this.encryptedVault[id];
    if (!encrypted || profile.credentialStatus !== "ready") throw new Error("Configure a local credential for this CLI agent before running it.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure operating-system encryption is unavailable, so this credential cannot be used.");
    return { profile, apiKey: safeStorage.decryptString(Buffer.from(encrypted, "base64")) };
  }

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
    return CLI_CANDIDATES.map((candidate) => {
      return { ...candidate, available: Boolean(this.resolveCliExecutable(candidate.command)) };
    });
  }
  public resolveCliExecutable(command: string): string | null {
    const allowed = CLI_CANDIDATES.find((candidate) => candidate.command === command);
    if (!allowed) return null;
    const locator = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(locator, [allowed.command], { encoding: "utf8", windowsHide: true, timeout: 2_000 });
    const candidatePath = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0]?.trim() : undefined;
    if (!candidatePath || !isAbsolute(candidatePath)) return null;
    try { return lstatSync(candidatePath).isFile() ? candidatePath : null; } catch { return null; }
  }

  private load(): void {
    try {
      const stored = this.readPrivateJson<AgentProfileSummary[]>(this.profileFile, defaultAgentProfiles);
      for (const profile of stored) this.profiles.set(profile.id, profile);
      this.encryptedVault = this.readPrivateJson<StoredVault>(this.vaultFile, {});
      for (const profile of this.profiles.values()) if (this.encryptedVault[profile.id]) profile.credentialStatus = safeStorage.isEncryptionAvailable() ? "ready" : "unavailable";
    } catch {
      this.profiles = new Map(defaultAgentProfiles.map((profile) => [profile.id, profile]));
      this.encryptedVault = {};
    }
  }

  private persist(): void {
    const directory = dirname(this.profileFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { chmodSync(directory, 0o700); } catch { /* Best-effort on platforms without POSIX modes. */ }
    this.writePrivateJson(this.profileFile, this.list());
    this.writePrivateJson(this.vaultFile, this.encryptedVault);
  }
  private readPrivateJson<T>(file: string, fallback: T): T {
    if (!existsSync(file)) return fallback;
    if (lstatSync(file).isSymbolicLink()) throw new Error("Refusing a symlinked agent data file.");
    try { chmodSync(file, 0o600); } catch { /* Best-effort on platforms without POSIX modes. */ }
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }
  private writePrivateJson(file: string, data: unknown): void {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
    try { chmodSync(file, 0o600); } catch { /* Best-effort on platforms without POSIX modes. */ }
  }
}
