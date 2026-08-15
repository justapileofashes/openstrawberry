import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString("utf8").replace("encrypted:", "")),
};

vi.mock("electron", () => ({ safeStorage }));

const { AgentRegistry } = await import("./agent-registry.js");

let directory: string;
let profileFile: string;
let vaultFile: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-registry-"));
  profileFile = join(directory, "agents.json");
  vaultFile = join(directory, "agent-vault.json");
  safeStorage.isEncryptionAvailable.mockReturnValue(true);
  safeStorage.encryptString.mockClear();
  safeStorage.decryptString.mockClear();
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("AgentRegistry credential vault", () => {
  it("encrypts a credential into a private vault and never places the raw key in profile data", () => {
    const registry = new AgentRegistry(profileFile, vaultFile);
    const profile = registry.save({ id: "researcher", name: "Researcher", role: "researcher", provider: "OpenAI", model: "gpt-test", executor: "provider", apiKey: "private-key" });

    expect(profile.credentialStatus).toBe("ready");
    expect(JSON.parse(readFileSync(profileFile, "utf8"))).not.toContain("private-key");
    expect(readFileSync(vaultFile, "utf8")).not.toContain("private-key");
    expect(safeStorage.encryptString).toHaveBeenCalledWith("private-key");
    expect(statSync(profileFile).mode & 0o777).toBe(0o600);
    expect(statSync(vaultFile).mode & 0o777).toBe(0o600);
    expect(registry.resolveProviderCredential("researcher").apiKey).toBe("private-key");
  });

  it("refuses to store a credential without operating-system encryption", () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const registry = new AgentRegistry(profileFile, vaultFile);

    expect(() => registry.save({ id: "researcher", name: "Researcher", role: "researcher", provider: "OpenAI", model: "gpt-test", executor: "provider", apiKey: "private-key" })).toThrow("Secure operating-system encryption is unavailable");
  });

  it("clears an existing vault binding without deleting the profile", () => {
    const registry = new AgentRegistry(profileFile, vaultFile);
    registry.save({ id: "researcher", name: "Researcher", role: "researcher", provider: "OpenAI", model: "gpt-test", executor: "provider", apiKey: "private-key" });

    const profile = registry.save({ id: "researcher", name: "Researcher", role: "researcher", provider: "OpenAI", model: "gpt-test", executor: "provider", clearCredential: true });

    expect(profile.credentialStatus).toBe("not-configured");
    expect(registry.list().find((agent) => agent.id === "researcher")).toBeDefined();
    expect(() => registry.resolveProviderCredential("researcher")).toThrow("Configure a local API key");
  });
});
