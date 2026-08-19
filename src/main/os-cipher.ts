/**
 * The operating system's at-rest encryption, expressed as a `CipherPort`.
 *
 * This is its own module because `safeStorage.isEncryptionAvailable()` does not
 * answer the question `SecretStore` actually needs answered. It reports whether
 * the encryptor will *work*, not whether the result is worth trusting:
 *
 *   - On Linux, when no keyring is present — a bare desktop, a container, a
 *     session with no D-Bus, or `--password-store=basic` — Chromium selects the
 *     `basic_text` backend, which obfuscates with a key compiled into the binary.
 *     `isEncryptionAvailable()` returns true there. Trusting it would write a
 *     file named `.enc` that anyone who copies it can read, which is precisely
 *     the outcome the store's refuse-to-store rule exists to prevent. So on
 *     Linux the selected backend must also name a real keyring.
 *   - On macOS (Keychain) and Windows (DPAPI) there is no such fallback: the
 *     availability check is the whole answer, and the Linux-only backend query
 *     is never called.
 *
 * The consequence of returning false here is deliberate and not a degradation to
 * something weaker: the store refuses the write, and the chrome explains that no
 * key was saved. A user on such a system is told the truth instead of being
 * handed a false guarantee.
 *
 * `safeStorage` and the platform are injected so this policy is unit testable
 * without booting Electron, matching how the rest of the trusted process keeps
 * its policy logic checkable.
 */
import type { EncryptionState } from "../shared/agents.js";
import type { CipherPort } from "./secret-store.js";

/** The slice of Electron's `safeStorage` this module uses. */
export interface SafeStoragePort {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (plaintext: string) => Buffer;
  readonly decryptString: (ciphertext: Buffer) => string;
  /** Linux only. Names the password store Chromium selected. */
  readonly getSelectedStorageBackend: () => string;
}

/**
 * Linux backends that mean "nothing here is protecting the key".
 *
 * `basic_text` encrypts with a hardcoded key, so its ciphertext is reversible by
 * anyone with the binary. `unknown` is what Electron reports before the `ready`
 * event, when the answer is not yet knowable — and an unknown backend is not a
 * basis for writing a secret either. Both are treated as no encryption at all.
 */
const UNTRUSTED_LINUX_BACKENDS: readonly string[] = ["basic_text", "unknown"];

export interface OsCipherOptions {
  readonly safeStorage: SafeStoragePort;
  /** `process.platform`. Injected so the Linux rule is testable on any host. */
  readonly platform: string;
}

export function createOsCipher(options: OsCipherOptions): CipherPort {
  const { safeStorage, platform } = options;

  return {
    availability: (): EncryptionState => {
      // Asked first, so the Linux-only backend query is never reached on a
      // platform that does not implement it.
      if (!safeStorage.isEncryptionAvailable()) return "unavailable";
      if (platform !== "linux") return "available";

      return UNTRUSTED_LINUX_BACKENDS.includes(safeStorage.getSelectedStorageBackend())
        ? "no-keyring"
        : "available";
    },
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
  };
}
