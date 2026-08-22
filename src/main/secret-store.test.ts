import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CredentialStorageUnavailableError,
  SecretStore,
  type CipherPort
} from "./secret-store.js";

/**
 * A stand-in for the OS keychain: reversible, and obviously not plaintext.
 * Returns a real `Buffer`, because `safeStorage.encryptString` does.
 */
function bufferCipher(overrides: Partial<CipherPort> = {}): CipherPort {
  const shift = 42;
  return {
    availability: () => "available",
    encrypt: (plaintext) =>
      Buffer.from([...Buffer.from(plaintext, "utf8")].map((byte) => byte ^ shift)),
    decrypt: (ciphertext) =>
      Buffer.from([...ciphertext].map((byte) => byte ^ shift)).toString("utf8"),
    ...overrides
  };
}

const SECRET = "sk-ant-do-not-leak-this-value";

let directory: string;

function storeWith(cipher: CipherPort): SecretStore {
  return new SecretStore({
    credentialPath: join(directory, "agent-credentials.enc"),
    profilePath: join(directory, "agent-profile.json"),
    cipher
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-secrets-"));
});

afterEach(() => {
  directory = "";
});

describe("SecretStore", () => {
  it("refuses to store when the OS cannot encrypt, rather than writing plaintext", () => {
    const store = storeWith(bufferCipher({ availability: () => "unavailable" }));

    expect(() => store.setCredential("anthropic", SECRET)).toThrow(
      CredentialStorageUnavailableError
    );
    // The refusal is the point: no file at all beats a file that claims to be
    // encrypted and is not.
    expect(existsSync(join(directory, "agent-credentials.enc"))).toBe(false);
    expect(store.status().configured).toBe(false);
    expect(store.status().encryption).toBe("unavailable");
  });

  it("writes ciphertext, so the key is not recoverable from the file", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);

    const onDisk = readFileSync(join(directory, "agent-credentials.enc"));

    expect(onDisk.byteLength).toBeGreaterThan(0);
    expect(onDisk.toString("utf8")).not.toContain(SECRET);
    expect(onDisk.toString("latin1")).not.toContain(SECRET);
  });

  it("never puts the key in the status the renderer receives", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);

    const status = store.status();

    expect(status.configured).toBe(true);
    // Serialized, because the renderer receives this over IPC as JSON — the
    // question is what crosses the boundary, not what the type says.
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(Object.values(status)).not.toContain(SECRET);
  });

  it("keeps the key out of the profile file entirely", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setOrchestrator("anthropic", "claude-sonnet-5");

    const profile = readFileSync(join(directory, "agent-profile.json"), "utf8");

    expect(profile).not.toContain(SECRET);
    expect(JSON.parse(profile)).toEqual({
      version: 1,
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: null,
      command: null,
      // Written as four explicit nulls rather than omitted, so the file states
      // "nothing was configured" instead of leaving it to be inferred.
      tuning: {
        providerLabel: null,
        supportsImages: null,
        contextWindow: null,
        temperature: null
      }
    });
  });

  it("does not repoint the orchestrator just because a key was stored", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openai", SECRET);

    // Connecting a provider so one agent can be pinned to it is a different act
    // from moving everything that follows the orchestrator.
    expect(store.status().provider).toBe("anthropic");
    expect(store.status().model).toBe("claude-opus-5");
  });

  it("returns the key to the trusted process that asks for it", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);

    expect(store.readCredential()).toBe(SECRET);
  });

  it("survives a restart, reading the profile back from disk", () => {
    storeWith(bufferCipher()).setCredential("anthropic", SECRET);

    const reopened = storeWith(bufferCipher());

    expect(reopened.status().configured).toBe(true);
    expect(reopened.status().provider).toBe("anthropic");
    expect(reopened.readCredential()).toBe(SECRET);
  });

  it("reports not-configured when the stored key no longer decrypts", () => {
    storeWith(bufferCipher()).setCredential("anthropic", SECRET);

    // A keychain entry revoked since the key was written: the file is there and
    // undecryptable. Reporting it as configured would send the user hunting
    // through a provider dashboard for a local problem.
    const store = storeWith(
      bufferCipher({
        decrypt: () => {
          throw new Error("decryption failed");
        }
      })
    );

    expect(store.status().configured).toBe(false);
    expect(store.readCredential()).toBeNull();
  });

  it("treats a corrupt or empty credential file as not configured", () => {
    writeFileSync(join(directory, "agent-credentials.enc"), Buffer.alloc(0));
    expect(storeWith(bufferCipher()).status().configured).toBe(false);

    writeFileSync(join(directory, "agent-credentials.enc"), "not ciphertext");
    expect(() => storeWith(bufferCipher()).status()).not.toThrow();
  });

  it("reports not-configured when encryption became unavailable after storing", () => {
    storeWith(bufferCipher()).setCredential("anthropic", SECRET);

    const store = storeWith(bufferCipher({ availability: () => "unavailable" }));

    expect(store.status().configured).toBe(false);
    expect(store.readCredential()).toBeNull();
  });

  it("forgets the key on clear", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);

    expect(store.clearCredential().configured).toBe(false);
    expect(store.readCredential()).toBeNull();
    expect(existsSync(join(directory, "agent-credentials.enc"))).toBe(false);
  });

  it("is safe to clear when nothing was ever stored", () => {
    const store = storeWith(bufferCipher());

    expect(() => store.clearCredential()).not.toThrow();
    expect(store.status().configured).toBe(false);
  });

  it("falls back to defaults when the profile file is hand-edited into nonsense", () => {
    writeFileSync(join(directory, "agent-profile.json"), "{ not json");

    const status = storeWith(bufferCipher()).status();

    expect(status.provider).toBe("anthropic");
    expect(status.model).toBe("claude-opus-5");
  });

  it("treats a cipher that throws on availability as unavailable", () => {
    const store = storeWith(
      bufferCipher({
        availability: () => {
          throw new Error("keychain exploded");
        }
      })
    );

    expect(store.isEncryptionAvailable()).toBe(false);
    expect(store.encryptionState()).toBe("unavailable");
    expect(() => store.setCredential("anthropic", SECRET)).toThrow(
      CredentialStorageUnavailableError
    );
  });

  it("leaves a credential alone when the cipher merely reports no keyring", () => {
    storeWith(bufferCipher()).setCredential("anthropic", SECRET);

    // No keyring, but the stored bytes do not decrypt under the fallback — the
    // signature of a key a real keyring wrote. That keyring may be locked rather
    // than gone, so the file must survive.
    const store = storeWith(
      bufferCipher({
        availability: () => "no-keyring",
        decrypt: () => {
          throw new Error("decryption failed");
        }
      })
    );

    expect(store.discardExposedCredential()).toBe(false);
    expect(existsSync(join(directory, "agent-credentials.enc"))).toBe(true);
  });

  it("discards nothing when there is nothing stored", () => {
    const store = storeWith(bufferCipher({ availability: () => "no-keyring" }));

    expect(store.discardExposedCredential()).toBe(false);
  });
});

describe("SecretStore with several providers", () => {
  const OTHER = "sk-openai-also-do-not-leak";

  it("holds one key per provider without either overwriting the other", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openai", OTHER);

    expect(store.readCredential("anthropic")).toBe(SECRET);
    expect(store.readCredential("openai")).toBe(OTHER);
  });

  it("forgets one provider's key and leaves the rest alone", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openai", OTHER);

    store.clearCredential("openai");

    expect(store.readCredential("openai")).toBeNull();
    expect(store.readCredential("anthropic")).toBe(SECRET);
  });

  it("removes the file once the last key is cleared", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openai", OTHER);

    store.clearCredential("anthropic");
    store.clearCredential("openai");

    expect(existsSync(join(directory, "agent-credentials.enc"))).toBe(false);
  });

  it("keeps no key recoverable from the file, whichever provider it belongs to", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openai", OTHER);

    const onDisk = readFileSync(join(directory, "agent-credentials.enc"));

    expect(onDisk.toString("utf8")).not.toContain(SECRET);
    expect(onDisk.toString("utf8")).not.toContain(OTHER);
    expect(onDisk.toString("latin1")).not.toContain(OTHER);
  });

  it("reports each provider's key state, and never the key", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openai", OTHER);

    const status = store.status();
    const openai = status.providers.find((entry) => entry.id === "openai");
    const anthropic = status.providers.find((entry) => entry.id === "anthropic");

    expect(openai?.configured).toBe(true);
    expect(anthropic?.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain(OTHER);
  });

  it("calls a local provider ready with no key stored", () => {
    const store = storeWith(bufferCipher());
    store.setOrchestrator("ollama", "llama3.1");

    // Nothing to authenticate against, so demanding a key would report a
    // problem the user has no way to fix.
    const status = store.status();

    expect(status.configured).toBe(true);
    expect(status.providers.find((entry) => entry.id === "ollama")?.configured).toBe(false);
  });

  it("reports the orchestrator's provider as unconfigured until it has a key", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setOrchestrator("openai", "gpt-5");

    // The intent is stored even though the key is missing; the missing key is
    // what gets reported, rather than the change being refused.
    expect(store.status().provider).toBe("openai");
    expect(store.status().configured).toBe(false);
  });

  it("keeps the orchestrator across a restart", () => {
    storeWith(bufferCipher()).setOrchestrator("google", "gemini-2.5-pro");

    const reopened = storeWith(bufferCipher()).status();

    expect(reopened.provider).toBe("google");
    expect(reopened.model).toBe("gemini-2.5-pro");
  });

  it("reads a credential file written before providers could hold their own key", () => {
    // The legacy format is one raw key, which belonged to the only provider a
    // key could be stored for: the one the profile names.
    const cipher = bufferCipher();
    writeFileSync(join(directory, "agent-credentials.enc"), cipher.encrypt(SECRET));

    const store = storeWith(cipher);

    expect(store.readCredential("anthropic")).toBe(SECRET);
    expect(store.status().configured).toBe(true);
  });

  it("migrates a legacy file on the next write rather than losing the old key", () => {
    const cipher = bufferCipher();
    writeFileSync(join(directory, "agent-credentials.enc"), cipher.encrypt(SECRET));

    const store = storeWith(cipher);
    store.setCredential("openai", OTHER);

    expect(store.readCredential("anthropic")).toBe(SECRET);
    expect(store.readCredential("openai")).toBe(OTHER);
  });

  it("prefers an agent's own key over the shared one", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openrouter", SECRET);
    store.setCredential("openrouter", OTHER, "companion-2");

    expect(store.readCredential("openrouter", "companion-2")).toBe(OTHER);
    // An agent without its own key still authenticates, using the shared one.
    expect(store.readCredential("openrouter", "companion-1")).toBe(SECRET);
    expect(store.readCredential("openrouter")).toBe(SECRET);
  });

  it("falls back to the shared key rather than failing the agent outright", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openrouter", SECRET);

    expect(store.readCredential("openrouter", "companion-2")).toBe(SECRET);
  });

  it("keeps one agent's key from reaching another agent or another provider", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openrouter", OTHER, "companion-2");

    expect(store.readCredential("openrouter", "companion-3")).toBeNull();
    expect(store.readCredential("openai", "companion-2")).toBeNull();
  });

  it("reports which agents hold their own key, and never the key", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openrouter", OTHER, "companion-2");

    const status = store.status();

    expect(status.agentCredentials).toEqual([
      { companionId: "companion-2", provider: "openrouter" }
    ]);
    // A per-agent key must not turn into a claim that the provider is connected
    // for everyone.
    expect(status.providers.find((entry) => entry.id === "openrouter")?.configured).toBe(
      false
    );
    expect(JSON.stringify(status)).not.toContain(OTHER);
  });

  it("clears one agent's key without touching the shared one", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("openrouter", SECRET);
    store.setCredential("openrouter", OTHER, "companion-2");

    store.clearCredential("openrouter", "companion-2");

    expect(store.status().agentCredentials).toEqual([]);
    expect(store.readCredential("openrouter")).toBe(SECRET);
  });

  it("forgets every key an agent held when the agent goes", () => {
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openrouter", OTHER, "companion-2");
    store.setCredential("openai", OTHER, "companion-2");
    store.setCredential("openai", SECRET, "companion-3");

    store.forgetCompanion("companion-2");

    // A credential outliving the only thing that could use it is a secret kept
    // for no reason — but only that agent's.
    expect(store.status().agentCredentials).toEqual([
      { companionId: "companion-3", provider: "openai" }
    ]);
    expect(store.readCredential("anthropic")).toBe(SECRET);
  });

  it("stores an orchestrator endpoint alongside its provider and model", () => {
    const store = storeWith(bufferCipher());
    store.setOrchestrator("openai-compatible", "llama-3.3", "https://api.example.com/v1");

    expect(store.status().baseUrl).toBe("https://api.example.com/v1");
    expect(storeWith(bufferCipher()).status().baseUrl).toBe("https://api.example.com/v1");
  });

  it("leaves no temporary file beside the credential store", () => {
    // The credential file is written through a rename. A leftover temporary
    // would be ciphertext sitting under a name nothing manages or clears.
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openai", OTHER);

    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps every stored key when one provider's key is replaced", () => {
    // The map is written whole on every change, so this is the check that a
    // rewrite carries the other scopes across rather than replacing the file
    // with just the key that moved.
    const store = storeWith(bufferCipher());
    store.setCredential("anthropic", SECRET);
    store.setCredential("openai", OTHER);
    store.setCredential("anthropic", `${SECRET}-rotated`);

    const reopened = storeWith(bufferCipher());
    expect(reopened.readCredential("anthropic")).toBe(`${SECRET}-rotated`);
    expect(reopened.readCredential("openai")).toBe(OTHER);
  });

  it("ignores a stored scope naming a provider the app no longer ships", () => {
    const cipher = bufferCipher();
    writeFileSync(
      join(directory, "agent-credentials.enc"),
      cipher.encrypt(JSON.stringify({ anthropic: SECRET, "not-a-provider": OTHER }))
    );

    const status = storeWith(cipher).status();

    expect(status.providers.map((entry) => entry.id)).not.toContain("not-a-provider");
    expect(JSON.stringify(status)).not.toContain(OTHER);
  });
});
