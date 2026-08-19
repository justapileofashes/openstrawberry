import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createOsCipher, type SafeStoragePort } from "./os-cipher.js";
import { CredentialStorageUnavailableError, SecretStore } from "./secret-store.js";

const SHIFT = 42;

function obfuscate(bytes: Iterable<number>): Buffer {
  return Buffer.from([...bytes].map((byte) => byte ^ SHIFT));
}

/**
 * A stand-in for Electron's `safeStorage`.
 *
 * Two details are modelled deliberately, because the behaviour under test
 * depends on them:
 *
 *   - `keyId` stands in for Chromium's versioned ciphertext prefix. A blob is
 *     tagged with the key that wrote it, and decrypting one written under a
 *     different backend **throws** rather than returning garbage — which is what
 *     `safeStorage.decryptString` does when the prefix names a key the current
 *     backend cannot supply.
 *   - `getSelectedStorageBackend` throws by default, because on Windows and
 *     macOS it must never be consulted. A test that passed only because a stub
 *     returned something benign would not catch a call that throws in production.
 */
function fakeSafeStorage(
  overrides: Partial<SafeStoragePort> = {},
  keyId = "keyring"
): SafeStoragePort {
  const tag = Buffer.from(`${keyId}:`, "utf8");

  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) =>
      Buffer.concat([tag, obfuscate(Buffer.from(plaintext, "utf8"))]),
    decryptString: (ciphertext) => {
      if (!ciphertext.subarray(0, tag.byteLength).equals(tag)) {
        throw new Error("Error while decrypting the ciphertext provided");
      }
      return obfuscate(ciphertext.subarray(tag.byteLength)).toString("utf8");
    },
    getSelectedStorageBackend: () => {
      throw new Error("getSelectedStorageBackend is Linux-only");
    },
    ...overrides
  };
}

/** The keyringless fallback: a key compiled into the binary, reversible by anyone. */
function fallbackSafeStorage(): SafeStoragePort {
  return fakeSafeStorage({ getSelectedStorageBackend: () => "basic_text" }, "hardcoded");
}

/** A session with a real keyring holding the key. */
function keyringSafeStorage(backend = "gnome_libsecret"): SafeStoragePort {
  return fakeSafeStorage({ getSelectedStorageBackend: () => backend }, "keyring");
}

const SECRET = "sk-ant-do-not-leak-this-value";
const CREDENTIAL_FILE = "agent-credentials.enc";

describe("createOsCipher", () => {
  it("trusts Keychain and DPAPI without asking for a Linux backend", () => {
    for (const platform of ["darwin", "win32"]) {
      const cipher = createOsCipher({ safeStorage: fakeSafeStorage(), platform });

      // The default stub throws from `getSelectedStorageBackend`, so this also
      // asserts the Linux-only API is not reached here.
      expect(cipher.availability()).toBe("available");
    }
  });

  it("trusts a Linux session backed by a real keyring", () => {
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      const cipher = createOsCipher({
        safeStorage: keyringSafeStorage(backend),
        platform: "linux"
      });

      expect(cipher.availability()).toBe("available");
    }
  });

  it("names the missing keyring on Linux, despite safeStorage saying yes", () => {
    // The case this module exists for: `basic_text` encrypts with a key compiled
    // into the binary, and `isEncryptionAvailable()` still returns true. The
    // state is distinct from `unavailable` because the user can fix this one.
    const cipher = createOsCipher({
      safeStorage: fallbackSafeStorage(),
      platform: "linux"
    });

    expect(cipher.availability()).toBe("no-keyring");
  });

  it("reports no keyring when the Linux backend is not yet knowable", () => {
    // `unknown` means the query ran before the app was ready. Writing a secret
    // against an unidentified backend is not a risk worth taking.
    const cipher = createOsCipher({
      safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => "unknown" }),
      platform: "linux"
    });

    expect(cipher.availability()).toBe("no-keyring");
  });

  it("reports unavailable when safeStorage itself declines, on any platform", () => {
    for (const platform of ["linux", "darwin", "win32"]) {
      const cipher = createOsCipher({
        safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }),
        platform
      });

      expect(cipher.availability()).toBe("unavailable");
    }
  });

  it("delegates encryption to safeStorage rather than rolling its own", () => {
    const cipher = createOsCipher({ safeStorage: fakeSafeStorage(), platform: "win32" });

    const ciphertext = cipher.encrypt(SECRET);

    expect(ciphertext.toString("utf8")).not.toContain(SECRET);
    expect(cipher.decrypt(ciphertext)).toBe(SECRET);
  });
});

describe("createOsCipher with SecretStore", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "openstrawberry-os-cipher-"));
  });

  function storeWith(safeStorage: SafeStoragePort, platform: string): SecretStore {
    return new SecretStore({
      credentialPath: join(directory, CREDENTIAL_FILE),
      profilePath: join(directory, "agent-profile.json"),
      cipher: createOsCipher({ safeStorage, platform })
    });
  }

  it("writes no key on a keyringless Linux box", () => {
    const store = storeWith(fallbackSafeStorage(), "linux");

    expect(() => store.setCredential("anthropic", SECRET)).toThrow(
      CredentialStorageUnavailableError
    );
    // No file at all. A `.enc` file reversible by anyone holding the binary is
    // worse than none, because its name claims otherwise.
    expect(existsSync(join(directory, CREDENTIAL_FILE))).toBe(false);
    expect(store.status().encryption).toBe("no-keyring");
  });

  it("stores and reads back a key where the OS really does encrypt", () => {
    const store = storeWith(keyringSafeStorage(), "linux");

    expect(store.setCredential("anthropic", SECRET).configured).toBe(true);
    expect(store.readCredential()).toBe(SECRET);
  });

  it("stops trusting a key once the keyring it was written under is gone", () => {
    storeWith(keyringSafeStorage("kwallet6"), "linux").setCredential("anthropic", SECRET);

    const degraded = storeWith(fallbackSafeStorage(), "linux");

    expect(degraded.status().configured).toBe(false);
    expect(degraded.readCredential()).toBeNull();
  });

  it("removes a key an older build wrote through the keyringless fallback", () => {
    // Exactly what an older build left behind: ciphertext under the compiled-in
    // key, which anyone holding the file and the binary can reverse.
    const fallback = fallbackSafeStorage();
    writeFileSync(join(directory, CREDENTIAL_FILE), fallback.encryptString(SECRET));

    const store = storeWith(fallback, "linux");

    expect(store.discardExposedCredential()).toBe(true);
    expect(existsSync(join(directory, CREDENTIAL_FILE))).toBe(false);
  });

  it("keeps a key the keyring wrote, because a locked keyring can come back", () => {
    storeWith(keyringSafeStorage(), "linux").setCredential("anthropic", SECRET);

    // Same file, keyring now absent. These bytes are still protected by a key
    // this session cannot reach, so deleting them would destroy a recoverable
    // credential to fix an exposure they do not have.
    const degraded = storeWith(fallbackSafeStorage(), "linux");

    expect(degraded.discardExposedCredential()).toBe(false);
    expect(existsSync(join(directory, CREDENTIAL_FILE))).toBe(true);

    // And the key still works once the keyring is unlocked again.
    expect(storeWith(keyringSafeStorage(), "linux").readCredential()).toBe(SECRET);
  });

  it("never evicts on a platform whose encryption is trusted", () => {
    const store = storeWith(fakeSafeStorage(), "win32");
    store.setCredential("anthropic", SECRET);

    expect(store.discardExposedCredential()).toBe(false);
    expect(store.readCredential()).toBe(SECRET);
  });
});
