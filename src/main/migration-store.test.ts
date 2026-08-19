import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BookmarkStore,
  MigrationStateStore,
  StagedPasswordStorageUnavailableError,
  StagedPasswordVault
} from "./migration-store.js";
import type { CipherPort } from "./secret-store.js";
import type { ImportedBookmark } from "../shared/migration.js";
import type { StagedPasswordRecord } from "./password-csv.js";

/** Reversible, and obviously not plaintext — the same stand-in `SecretStore` uses. */
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

const PASSWORD = "correct-horse-battery-staple-9182";
const USERNAME = "person@example.com";

const CREDENTIALS: readonly StagedPasswordRecord[] = [
  { url: "https://example.com/", username: USERNAME, password: PASSWORD },
  { url: "https://other.test/login", username: "second", password: "another-secret-value" }
];

function bookmark(url: string, folderPath: readonly string[] = []): ImportedBookmark {
  return { title: `Title for ${url}`, url, folderPath };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-migration-"));
});

function bookmarkStore(): BookmarkStore {
  return new BookmarkStore({ path: join(directory, "bookmarks.json") });
}

function vaultWith(cipher: CipherPort): StagedPasswordVault {
  return new StagedPasswordVault({ path: join(directory, "staged-passwords.enc"), cipher });
}

describe("BookmarkStore", () => {
  it("commits a reviewed set and reads it back", () => {
    const store = bookmarkStore();
    const result = store.commit(
      [bookmark("https://a.test/"), bookmark("https://b.test/", ["Work"])],
      { deduplicate: true }
    );

    expect(result.added).toBe(2);
    expect(result.folderCount).toBe(1);
    expect(store.count()).toBe(2);
  });

  it("skips a bookmark already saved in the same folder", () => {
    const store = bookmarkStore();
    store.commit([bookmark("https://a.test/page", ["Work"])], { deduplicate: true });

    const second = store.commit(
      [
        bookmark("HTTPS://A.test/page#fragment", ["work"]),
        bookmark("https://a.test/page", ["Home"]),
        bookmark("https://new.test/", ["Work"])
      ],
      { deduplicate: true }
    );

    expect(second.skippedDuplicates).toBe(1);
    expect(second.added).toBe(2);
    expect(second.warnings.map((warning) => warning.code)).toContain("duplicates-skipped");
    expect(store.count()).toBe(3);
  });

  it("creates duplicates when the user turns deduplication off", () => {
    const store = bookmarkStore();
    store.commit([bookmark("https://a.test/")], { deduplicate: true });
    const second = store.commit([bookmark("https://a.test/")], { deduplicate: false });

    expect(second.skippedDuplicates).toBe(0);
    expect(store.count()).toBe(2);
  });

  it("writes whole or not at all, leaving no temporary file behind", () => {
    const store = bookmarkStore();
    store.commit([bookmark("https://a.test/")], { deduplicate: true });

    const files = readdirSync(directory);
    expect(files).toContain("bookmarks.json");
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("writes nothing at all when a commit adds nothing", () => {
    const store = bookmarkStore();
    store.commit([bookmark("javascript:alert(1)")], { deduplicate: true });

    expect(existsSync(join(directory, "bookmarks.json"))).toBe(false);
  });

  it("drops an entry that no longer passes the scheme gate on read", () => {
    writeFileSync(
      join(directory, "bookmarks.json"),
      JSON.stringify({
        version: 1,
        bookmarks: [
          { title: "Fine", url: "https://ok.test/", folderPath: [] },
          { title: "Injected", url: "javascript:alert(1)", folderPath: [] },
          { title: "Local", url: "file:///etc/passwd", folderPath: [] },
          { title: "Broken", url: 42, folderPath: [] }
        ]
      })
    );

    expect(bookmarkStore().read().map((entry) => entry.url)).toEqual(["https://ok.test/"]);
  });

  it("treats a corrupt or foreign file as empty rather than throwing", () => {
    for (const contents of ["", "{", "[]", JSON.stringify({ version: 99, bookmarks: [] })]) {
      writeFileSync(join(directory, "bookmarks.json"), contents);
      expect(bookmarkStore().read()).toEqual([]);
    }
  });
});

describe("StagedPasswordVault", () => {
  it("refuses to stage when the OS cannot encrypt, rather than writing plaintext", () => {
    for (const availability of ["unavailable", "no-keyring"] as const) {
      const vault = vaultWith(bufferCipher({ availability: () => availability }));

      expect(() => vault.stage(CREDENTIALS)).toThrow(StagedPasswordStorageUnavailableError);
      // The refusal is the point: no file at all beats a file of passwords.
      expect(existsSync(join(directory, "staged-passwords.enc"))).toBe(false);
      expect(vault.count()).toBe(0);
    }
  });

  it("refuses when the cipher throws while being asked", () => {
    const vault = vaultWith(
      bufferCipher({
        availability: () => {
          throw new Error("keychain unavailable");
        }
      })
    );

    expect(() => vault.stage(CREDENTIALS)).toThrow(StagedPasswordStorageUnavailableError);
    expect(existsSync(join(directory, "staged-passwords.enc"))).toBe(false);
  });

  it("writes bytes that do not contain any plaintext value", () => {
    const vault = vaultWith(bufferCipher());
    expect(vault.stage(CREDENTIALS)).toBe(2);

    const bytes = readFileSync(join(directory, "staged-passwords.enc"));

    expect(bytes.byteLength).toBeGreaterThan(0);
    for (const encoding of ["utf8", "latin1", "base64", "hex"] as const) {
      const text = bytes.toString(encoding);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(USERNAME);
      expect(text).not.toContain("another-secret-value");
    }

    // Not even the origin, which is a fact about the user's accounts.
    expect(bytes.toString("utf8")).not.toContain("example.com");
  });

  it("counts staged entries without decrypting one", () => {
    let decryptions = 0;
    const vault = vaultWith(
      bufferCipher({
        decrypt: (ciphertext) => {
          decryptions += 1;
          return ciphertext.toString("utf8");
        }
      })
    );

    vault.stage(CREDENTIALS);

    expect(vault.count()).toBe(2);
    expect(decryptions).toBe(0);
  });

  it("appends rather than replacing, so a second run keeps the first", () => {
    const vault = vaultWith(bufferCipher());
    vault.stage([CREDENTIALS[0]!]);
    vault.stage([CREDENTIALS[1]!]);

    expect(vault.count()).toBe(2);
  });

  it("deletes every staged entry and is safe to call twice", () => {
    const vault = vaultWith(bufferCipher());
    vault.stage(CREDENTIALS);
    expect(vault.count()).toBe(2);

    vault.deleteAll();
    vault.deleteAll();

    expect(existsSync(join(directory, "staged-passwords.enc"))).toBe(false);
    expect(vault.count()).toBe(0);
  });

  it("can still delete when the platform can no longer decrypt", () => {
    const vault = vaultWith(bufferCipher());
    vault.stage(CREDENTIALS);

    const broken = vaultWith(bufferCipher({ availability: () => "unavailable" }));
    broken.deleteAll();

    expect(existsSync(join(directory, "staged-passwords.enc"))).toBe(false);
  });

  it("stages nothing when given nothing", () => {
    const vault = vaultWith(bufferCipher());
    expect(vault.stage([])).toBe(0);
    expect(existsSync(join(directory, "staged-passwords.enc"))).toBe(false);
  });

  it("exposes no method that returns a stored credential", () => {
    const vault = vaultWith(bufferCipher());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(vault) as object);

    expect(methods.sort()).toEqual(
      ["constructor", "count", "deleteAll", "isEncryptionAvailable", "readCiphertexts", "stage"].sort()
    );
  });
});

describe("MigrationStateStore", () => {
  it("starts pending and persists what it is told", () => {
    const path = join(directory, "migration.json");
    const store = new MigrationStateStore({ path });

    expect(store.read().status).toBe("pending");

    store.write({ ...store.read(), status: "completed", totalBookmarkCount: 12 });

    expect(new MigrationStateStore({ path }).read()).toMatchObject({
      status: "completed",
      totalBookmarkCount: 12
    });
  });

  it("recovers from a corrupt file by offering the wizard again", () => {
    const path = join(directory, "migration.json");
    writeFileSync(path, "{ not json at all");

    expect(new MigrationStateStore({ path }).read().status).toBe("pending");
  });

  it("never writes a path or a secret, whatever it is handed", () => {
    const path = join(directory, "migration.json");
    const store = new MigrationStateStore({ path });

    store.write({ ...store.read(), status: "completed", defaultSearchName: "DuckDuckGo" });

    const written = readFileSync(path, "utf8");
    expect(written).not.toContain(directory);
    expect(written).not.toContain("password");
    // The shape has nowhere to put one, so this is a check on the shape holding.
    expect(Object.keys(JSON.parse(written) as object)).not.toContain("sourcePath");
  });
});
