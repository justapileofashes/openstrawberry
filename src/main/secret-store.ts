/**
 * Provider credentials, encrypted at rest and never read back to the chrome.
 *
 * Three rules, in order of importance:
 *
 *   1. If the operating system cannot encrypt, OpenStrawberry **refuses to
 *      store**. It never falls back to plaintext. A user who was told their key
 *      is protected must not silently get a file anyone can read.
 *   2. A key leaves this module in exactly one direction: `readCredential`,
 *      called by the provider adapter inside the trusted process. No IPC channel
 *      reaches it, and `status()` — the only thing the renderer ever sees — has
 *      no field that could carry one.
 *   3. The profile (the orchestrator's provider and model) lives in a separate
 *      file from the credentials. What you inspect is never what you must
 *      protect.
 *
 * Several providers can hold a key at once, because agents may be pinned to
 * different ones. They share a single ciphertext file rather than one file per
 * provider: which providers a user has configured is itself worth not leaving in
 * a directory listing.
 *
 * The cipher is injected rather than imported so this module can be tested
 * without booting Electron, matching how the rest of the trusted process keeps
 * its policy logic checkable.
 */
import { readFileSync, rmSync } from "node:fs";
import { writeFileAtomically } from "./atomic-write.js";
import {
  emptyAgentProfile,
  parseAgentProfile,
  providerDescriptor,
  PROVIDERS,
  type AgentConfigStatus,
  type AgentCredentialStatus,
  type AgentProfile,
  type EncryptionState,
  type ProviderId,
  type ProviderStatus
} from "../shared/agents.js";

/**
 * How one stored key is addressed: a provider's shared key, or one agent's own.
 *
 * The two live in one map under distinct string scopes rather than in two files,
 * so "does this agent have its own key" is a lookup rather than a second store
 * to keep consistent with the first.
 */
export interface CredentialScope {
  readonly provider: ProviderId;
  /** Null is the shared key that any agent without its own falls back to. */
  readonly companionId: string | null;
}

/**
 * The map key for a scope.
 *
 * `@` separates the two halves precisely because it is outside the identifier
 * charset both halves are validated against, so no provider and no agent id can
 * ever spell another scope's key.
 */
function scopeKey(scope: CredentialScope): string {
  return scope.companionId === null
    ? scope.provider
    : `${scope.provider}@${scope.companionId}`;
}

/** Reads a stored map key back, or null if it does not name a shipped provider. */
function parseScopeKey(key: string): CredentialScope | null {
  const separator = key.indexOf("@");
  const provider = separator === -1 ? key : key.slice(0, separator);
  if (providerDescriptor(provider) === null) return null;

  const companionId = separator === -1 ? null : key.slice(separator + 1);
  if (companionId !== null && companionId.length === 0) return null;

  return { provider: provider as ProviderId, companionId };
}

/** The platform's at-rest encryption, as this module needs it. */
export interface CipherPort {
  /** Whether the platform's encryption is real protection, and if not, why. */
  readonly availability: () => EncryptionState;
  readonly encrypt: (plaintext: string) => Buffer;
  readonly decrypt: (ciphertext: Buffer) => string;
}

export interface SecretStoreOptions {
  /** Ciphertext of the provider key. Never plaintext, never partially written. */
  readonly credentialPath: string;
  /** Non-secret provider and model metadata. */
  readonly profilePath: string;
  readonly cipher: CipherPort;
}

/**
 * Reads decrypted credential plaintext, in either the current or the legacy
 * format.
 *
 * Unknown providers and empty values are dropped rather than carried: the map is
 * about to be indexed by a provider id, so what comes out of it is restricted to
 * ids the app actually ships.
 */
function parseCredentialRecord(
  plaintext: string,
  legacyProvider: ProviderId
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext) as unknown;
  } catch {
    // The legacy format: one raw key, which no provider's format resembles JSON.
    return { [legacyProvider]: plaintext };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { [legacyProvider]: plaintext };
  }

  const credentials: Record<string, string> = {};
  for (const [scope, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (parseScopeKey(scope) === null) continue;
    if (typeof key !== "string" || key.length === 0) continue;
    credentials[scope] = key;
  }
  return credentials;
}

export class CredentialStorageUnavailableError extends Error {
  public constructor() {
    super(
      "This system has no OS-level encryption available, so the key was not saved."
    );
    this.name = "CredentialStorageUnavailableError";
  }
}

export class SecretStore {
  private readonly credentialPath: string;
  private readonly profilePath: string;
  private readonly cipher: CipherPort;

  private profile: AgentProfile;

  public constructor(options: SecretStoreOptions) {
    this.credentialPath = options.credentialPath;
    this.profilePath = options.profilePath;
    this.cipher = options.cipher;
    this.profile = this.readProfile();
  }

  /* --------------------------------------------------------------------- */
  /* Queries                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * What the renderer is allowed to know.
   *
   * `configured` is derived from whether a credential actually decrypts, not
   * from whether a file exists — a key encrypted under a keychain entry that has
   * since been revoked is not a usable credential, and reporting it as one would
   * send the user hunting through provider dashboards for a local problem.
   *
   * The top-level fields describe the orchestrator; `providers` describes every
   * provider an agent could be pinned to. Both are read once here so the two
   * cannot disagree within a single snapshot.
   */
  public status(): AgentConfigStatus {
    const credentials = this.readCredentials();

    const providers: readonly ProviderStatus[] = PROVIDERS.map((descriptor) => ({
      ...descriptor,
      configured: (credentials[descriptor.id] ?? "").length > 0
    }));

    const agentCredentials: AgentCredentialStatus[] = [];
    for (const key of Object.keys(credentials)) {
      const scope = parseScopeKey(key);
      if (scope === null || scope.companionId === null) continue;
      agentCredentials.push({
        companionId: scope.companionId,
        provider: scope.provider
      });
    }

    const orchestrator = providers.find((entry) => entry.id === this.profile.provider);

    return {
      // "Ready to run", not "has a key": a local provider authenticates nothing,
      // so demanding a key would leave the panel reporting a problem that has no
      // fix.
      configured:
        orchestrator !== undefined &&
        (orchestrator.configured || !orchestrator.requiresCredential),
      provider: this.profile.provider,
      model: this.profile.model,
      baseUrl: this.profile.baseUrl,
      command: this.profile.command,
      encryption: this.encryptionState(),
      providers,
      agentCredentials
    };
  }

  /** The orchestrator's provider and model — the fallback agents inherit. */
  public orchestrator(): AgentProfile {
    return this.profile;
  }

  /**
   * Why a key can or cannot be stored right now.
   *
   * A cipher that throws while answering is treated as unavailable: a keychain
   * that errors on being asked is not one to entrust a secret to.
   */
  public encryptionState(): EncryptionState {
    try {
      return this.cipher.availability();
    } catch {
      return "unavailable";
    }
  }

  public isEncryptionAvailable(): boolean {
    return this.encryptionState() === "available";
  }

  /**
   * The decrypted key for one provider, for the adapter in this process only.
   *
   * Defaults to the orchestrator's provider, so a caller that has no opinion
   * gets the same key the panel is describing.
   *
   * Returns null rather than throwing on a missing, corrupt, or undecryptable
   * file, so a damaged store reads as "not configured" and the user is offered
   * the connect flow again instead of a crash.
   */
  /**
   * An agent's own key wins over the shared one, and falls back to it.
   *
   * The fallback is what makes "connect this provider once" still work after
   * per-agent keys exist: an agent that was never given its own is not broken,
   * it is simply using the shared credential.
   */
  public readCredential(
    provider: ProviderId = this.profile.provider,
    companionId: string | null = null
  ): string | null {
    const credentials = this.readCredentials();

    const own =
      companionId === null
        ? undefined
        : credentials[scopeKey({ provider, companionId })];
    if (own !== undefined && own.length > 0) return own;

    const shared = credentials[scopeKey({ provider, companionId: null })];
    return shared !== undefined && shared.length > 0 ? shared : null;
  }

  /* --------------------------------------------------------------------- */
  /* Mutations                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Encrypts and stores one provider's key, leaving the others alone.
   *
   * Storing a key deliberately does not make that provider the orchestrator's.
   * Connecting a provider so an agent can be pinned to it is a different act
   * from changing what everything else inherits, and silently doing the second
   * would move every unpinned agent.
   *
   * Throws `CredentialStorageUnavailableError` when the OS cannot encrypt. That
   * refusal is the feature: the alternative is a plaintext key on disk under a
   * filename that claims otherwise.
   */
  public setCredential(
    provider: ProviderId,
    key: string,
    companionId: string | null = null
  ): AgentConfigStatus {
    if (!this.isEncryptionAvailable()) throw new CredentialStorageUnavailableError();

    const scope = scopeKey({ provider, companionId });
    this.writeCredentials({ ...this.readCredentials(), [scope]: key });
    return this.status();
  }

  /** Forgets one scope's key. Every other key, shared or per-agent, survives. */
  public clearCredential(
    provider: ProviderId = this.profile.provider,
    companionId: string | null = null
  ): AgentConfigStatus {
    const remaining = { ...this.readCredentials() };
    delete remaining[scopeKey({ provider, companionId })];

    try {
      this.writeCredentials(remaining);
    } catch {
      // A key that cannot be removed is reported as still configured by
      // `status()` rather than being claimed as gone.
    }
    return this.status();
  }

  /**
   * Drops every key an agent held, across all providers.
   *
   * Called when the agent is deleted. A key outliving the only thing that could
   * use it is a secret kept for no reason, and an id can be minted again.
   */
  public forgetCompanion(companionId: string): AgentConfigStatus {
    const credentials = this.readCredentials();
    const remaining: Record<string, string> = {};

    for (const [key, value] of Object.entries(credentials)) {
      if (parseScopeKey(key)?.companionId === companionId) continue;
      remaining[key] = value;
    }

    try {
      this.writeCredentials(remaining);
    } catch {
      // Same posture as `clearCredential`: what could not be removed keeps
      // being reported as present rather than claimed as gone.
    }
    return this.status();
  }

  /**
   * Points the orchestrator at a provider, model, and — where the provider needs
   * one — an endpoint.
   *
   * Every agent that has not been pinned follows this, so it is stored even when
   * that provider has no key yet: the user's intent survives, and `status()`
   * reports the missing key as the thing to fix.
   */
  public setOrchestrator(
    provider: ProviderId,
    model: string,
    baseUrl: string | null = null,
    command: string | null = null
  ): AgentConfigStatus {
    this.writeProfile({ ...this.profile, provider, model, baseUrl, command });
    return this.status();
  }

  /**
   * Removes a stored credential this system turns out not to be protecting.
   *
   * Called once at startup, and deliberately narrow: it removes the file only
   * when the backend is the keyringless fallback **and** the stored bytes decrypt
   * under it. Both together are proof that the key was written with a key
   * compiled into the binary, and so is readable by anyone who copies the file.
   *
   * The narrowness is the point. A credential written while a real keyring was
   * present does not decrypt under the fallback, and a keyring can come back —
   * locked at login, unlocked later in the session. Deleting that file would
   * destroy a recoverable key to fix an exposure it does not have, so it is left
   * where it is and simply not used.
   *
   * Returns whether a file was removed.
   */
  public discardExposedCredential(): boolean {
    if (this.encryptionState() !== "no-keyring") return false;

    try {
      const ciphertext = readFileSync(this.credentialPath);
      // An empty or undecryptable file is not an exposed key, and `decrypt`
      // throwing here is the ordinary signal that a real keyring wrote it.
      if (ciphertext.byteLength === 0) return false;
      if (this.cipher.decrypt(ciphertext).length === 0) return false;
    } catch {
      return false;
    }

    try {
      rmSync(this.credentialPath, { force: true });
      return true;
    } catch {
      // Nothing further to try. `status()` keeps reporting not-configured, so the
      // file is never used even while it remains on disk.
      return false;
    }
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Every stored key, by provider.
   *
   * A file written before per-provider keys existed holds one raw key rather
   * than a map, and is read as belonging to the orchestrator's provider — which
   * is what it was, since that was the only provider a key could be stored for.
   * Migration happens on the next write rather than eagerly, so merely reading
   * state never rewrites a credential file.
   */
  private readCredentials(): Record<string, string> {
    if (!this.isEncryptionAvailable()) return {};

    try {
      const ciphertext = readFileSync(this.credentialPath);
      if (ciphertext.byteLength === 0) return {};

      const plaintext = this.cipher.decrypt(ciphertext);
      if (plaintext.length === 0) return {};

      return parseCredentialRecord(plaintext, this.profile.provider);
    } catch {
      return {};
    }
  }

  /**
   * Writes the whole map, or removes the file once nothing is left in it.
   *
   * Atomically, because the map is all-or-nothing: `readCredentials` treats a
   * file it cannot decrypt as "no key was ever stored", so a write truncated by
   * a crash or a full disk would not corrupt one provider's key — it would
   * silently discard every key the user has, and report the store as unconfigured
   * rather than as damaged. The rename also re-creates the file on each write,
   * which is what keeps the owner-only mode applied; writing in place would set
   * it on creation only.
   */
  private writeCredentials(credentials: Record<string, string>): void {
    const kept = Object.entries(credentials).filter(
      ([scope, key]) => parseScopeKey(scope) !== null && key.length > 0
    );

    if (kept.length === 0) {
      rmSync(this.credentialPath, { force: true });
      return;
    }

    const ciphertext = this.cipher.encrypt(JSON.stringify(Object.fromEntries(kept)));
    writeFileAtomically(this.credentialPath, ciphertext);
  }

  private readProfile(): AgentProfile {
    try {
      // Strip a byte-order mark, which an editor or sync tool could introduce.
      const text = readFileSync(this.profilePath, "utf8").replace(/^﻿/u, "");
      return parseAgentProfile(JSON.parse(text) as unknown);
    } catch {
      return emptyAgentProfile();
    }
  }

  private writeProfile(next: AgentProfile): void {
    this.profile = next;
    try {
      writeFileAtomically(this.profilePath, JSON.stringify(next));
    } catch {
      // The profile is a convenience, not a correctness requirement: the
      // defaults are shipped in code, so a failed write costs nothing at rest.
    }
  }
}
