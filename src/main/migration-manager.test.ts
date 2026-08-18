import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MigrationManager, type MigrationDialogPort } from "./migration-manager.js";
import type { CipherPort } from "./secret-store.js";
import type { EncryptionState } from "../shared/agents.js";
import type { MigrationCommitPayload } from "../shared/migration.js";

const PASSWORD = "correct-horse-battery-staple-9182";

const CHROMIUM_BOOKMARKS = JSON.stringify({
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      children: [
        { type: "url", name: "Example", url: "https://example.com/" },
        {
          type: "folder",
          name: "Work",
          children: [
            { type: "url", name: "Docs", url: "https://docs.example.com/" },
            { type: "url", name: "Nope", url: "javascript:alert(1)" }
          ]
        }
      ]
    }
  }
});

const CHROMIUM_PREFERENCES = JSON.stringify({
  default_search_provider_data: {
    template_url_data: {
      short_name: "DuckDuckGo",
      keyword: "duckduckgo.com",
      url: "https://duckduckgo.com/?q={searchTerms}&secret=KEY"
    }
  },
  account_info: [{ email: "person@example.com" }]
});

const HTML_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://exported.test/one">One</A>
  <DT><H3>Folder</H3>
  <DL><p>
    <DT><A HREF="https://exported.test/two">Two</A>
  </DL><p>
</DL>`;

const CSV_EXPORT = [
  "name,url,username,password",
  `Example,https://example.com/,person@example.com,${PASSWORD}`,
  "Other,https://other.test/,second,another-secret",
  "Broken,android://hash@com.example.app/,third,skipped"
].join("\n");

function bufferCipher(availability: EncryptionState = "available"): CipherPort {
  const shift = 42;
  return {
    availability: () => availability,
    encrypt: (plaintext) =>
      Buffer.from([...Buffer.from(plaintext, "utf8")].map((byte) => byte ^ shift)),
    decrypt: (ciphertext) =>
      Buffer.from([...ciphertext].map((byte) => byte ^ shift)).toString("utf8")
  };
}

let root: string;
let home: string;
let userData: string;
let chosenFile: string | null;
let dialogCalls: number;

const dialog: MigrationDialogPort = {
  openFile: async () => {
    dialogCalls += 1;
    return chosenFile;
  }
};

/** Builds a manager over a real fixture tree, with the dialog and cipher faked. */
function managerWith(options: {
  readonly withChrome?: boolean;
  readonly encryption?: EncryptionState;
} = {}): MigrationManager {
  if (options.withChrome !== false) {
    const profile = join(home, ".config", "google-chrome", "Default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Bookmarks"), CHROMIUM_BOOKMARKS);
    writeFileSync(join(profile, "Preferences"), CHROMIUM_PREFERENCES);
    writeFileSync(
      join(home, ".config", "google-chrome", "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" } } } })
    );
  }

  return new MigrationManager({
    userDataDir: userData,
    cipher: bufferCipher(options.encryption ?? "available"),
    environment: { platform: "linux", homeDir: home, localAppData: "", roamingAppData: "" },
    dialog
  });
}

function commit(overrides: Partial<MigrationCommitPayload>): MigrationCommitPayload {
  return {
    sourceId: null,
    profileId: null,
    bookmarkHandle: null,
    passwordHandle: null,
    importBookmarks: false,
    importDefaultSearchName: false,
    stagePasswords: false,
    deduplicate: true,
    ...overrides
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openstrawberry-migrate-"));
  home = join(root, "home");
  userData = join(root, "userData");
  mkdirSync(home, { recursive: true });
  mkdirSync(userData, { recursive: true });
  chosenFile = null;
  dialogCalls = 0;
});

describe("overview", () => {
  it("reports a pending wizard, the detected browser, and nothing stored yet", () => {
    const overview = managerWith().overview();

    expect(overview.state.status).toBe("pending");
    expect(overview.sources).toHaveLength(1);
    expect(overview.sources[0]?.id).toBe("google-chrome");
    expect(overview.sources[0]?.profiles[0]?.displayName).toBe("Personal");
    expect(overview.storedBookmarkCount).toBe(0);
    expect(overview.stagedPasswordCount).toBe(0);
  });

  it("carries no local path to the renderer", () => {
    const serialized = JSON.stringify(managerWith().overview());
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("google-chrome/Default");
  });

  it("stays usable when no browser is installed", () => {
    const manager = managerWith({ withChrome: false });
    const overview = manager.overview();

    expect(overview.sources).toEqual([]);
    expect(overview.state.status).toBe("pending");
    // The fresh-profile escape route is unaffected by there being no source.
    expect(manager.startFresh().state.status).toBe("dismissed");
  });
});

describe("previewChromiumProfile", () => {
  it("reads the named profile and reports counts and a bounded sample", () => {
    const review = managerWith().previewChromiumProfile({
      sourceId: "google-chrome",
      profileId: "default"
    });

    expect(review.kind).toBe("chromium");
    expect(review.preview.bookmarkCount).toBe(2);
    expect(review.preview.folderCount).toBe(2);
    expect(review.preview.sample.length).toBeLessThanOrEqual(8);
    expect(review.handle).toMatch(/^mig-[0-9a-f-]+$/u);
    expect(review.preview.warnings.map((warning) => warning.code)).toContain(
      "unsafe-url-skipped"
    );
  });

  it("reads the search provider's name and nothing else from preferences", () => {
    const review = managerWith().previewChromiumProfile({
      sourceId: "google-chrome",
      profileId: "default"
    });

    expect(review.defaultSearchName).toBe("DuckDuckGo");

    const serialized = JSON.stringify(review);
    expect(serialized).not.toContain("searchTerms");
    expect(serialized).not.toContain("KEY");
    expect(serialized).not.toContain("person@example.com");
  });

  it("refuses a source or profile identifier it never minted", () => {
    const manager = managerWith();

    for (const payload of [
      { sourceId: "google-chrome", profileId: "profile-9" },
      { sourceId: "firefox", profileId: "default" },
      { sourceId: "safari", profileId: "default" },
      { sourceId: "unknown-browser", profileId: "default" }
    ]) {
      expect(() => manager.previewChromiumProfile(payload)).toThrow("Unknown migration source");
    }
  });

  it("reports an unreadable profile as a warning rather than a fault", () => {
    const manager = managerWith();
    // Replace the bookmark file with something no parser can make sense of.
    writeFileSync(join(home, ".config", "google-chrome", "Default", "Bookmarks"), "{ broken");

    const review = manager.previewChromiumProfile({
      sourceId: "google-chrome",
      profileId: "default"
    });

    expect(review.preview.bookmarkCount).toBe(0);
    expect(review.preview.warnings.map((warning) => warning.code)).toContain("file-malformed");
  });
});

describe("commit", () => {
  it("imports exactly the reviewed bookmarks and records the run", () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({
      sourceId: "google-chrome",
      profileId: "default"
    });

    const result = manager.commit(
      commit({
        sourceId: "google-chrome",
        profileId: "default",
        bookmarkHandle: review.handle,
        importBookmarks: true,
        importDefaultSearchName: true
      })
    );

    expect(result.importedBookmarkCount).toBe(2);
    expect(result.importedSearchName).toBe(true);
    expect(result.searchName).toBe("DuckDuckGo");
    expect(result.stagedPasswordCount).toBe(0);

    const overview = manager.overview();
    expect(overview.state.status).toBe("completed");
    expect(overview.state.runCount).toBe(1);
    expect(overview.state.defaultSearchName).toBe("DuckDuckGo");
    expect(overview.storedBookmarkCount).toBe(2);
  });

  it("skips bookmarks already saved when the second run deduplicates", () => {
    const manager = managerWith();

    const first = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });
    manager.commit(
      commit({
        sourceId: "google-chrome",
        profileId: "default",
        bookmarkHandle: first.handle,
        importBookmarks: true
      })
    );

    const second = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });
    const result = manager.commit(
      commit({
        sourceId: "google-chrome",
        profileId: "default",
        bookmarkHandle: second.handle,
        importBookmarks: true
      })
    );

    expect(result.importedBookmarkCount).toBe(0);
    expect(result.skippedDuplicateCount).toBe(2);
    expect(manager.overview().storedBookmarkCount).toBe(2);
  });

  it("consumes a handle, so the same review cannot be committed twice", () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });

    const payload = commit({
      sourceId: "google-chrome",
      profileId: "default",
      bookmarkHandle: review.handle,
      importBookmarks: true
    });

    manager.commit(payload);
    expect(() => manager.commit(payload)).toThrow("no longer available");
  });

  it("refuses a handle that was never minted", () => {
    const manager = managerWith();

    expect(() =>
      manager.commit(commit({ bookmarkHandle: "mig-not-a-real-handle", importBookmarks: true }))
    ).toThrow("no longer available");
  });

  it("refuses a review that does not match the named profile", () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });

    expect(() =>
      manager.commit(
        commit({
          sourceId: "brave",
          profileId: "default",
          bookmarkHandle: review.handle,
          importBookmarks: true
        })
      )
    ).toThrow("does not match the named source");
  });

  it("refuses a search-name import from a source that has no preferences", async () => {
    const manager = managerWith();
    chosenFile = join(root, "export.html");
    writeFileSync(chosenFile, HTML_EXPORT);

    const picked = await manager.pickHtmlBookmarks("firefox-html");
    const handle = picked.result?.handle ?? "";

    expect(() =>
      manager.commit(
        commit({ bookmarkHandle: handle, importBookmarks: true, importDefaultSearchName: true })
      )
    ).toThrow("only be imported from a browser profile");
  });

  it("returns counts and warnings only, with no value anywhere in the result", async () => {
    const manager = managerWith();
    chosenFile = join(root, "passwords.csv");
    writeFileSync(chosenFile, CSV_EXPORT);

    const picked = await manager.pickPasswordCsv();
    const result = manager.commit(
      commit({ passwordHandle: picked.result?.handle ?? "", stagePasswords: true })
    );

    expect(result.stagedPasswordCount).toBe(2);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain(root);
  });
});

describe("password staging", () => {
  it("parses a CSV into counts and recognised column names only", async () => {
    const manager = managerWith();
    chosenFile = join(root, "passwords.csv");
    writeFileSync(chosenFile, CSV_EXPORT);

    const picked = await manager.pickPasswordCsv();

    expect(picked.cancelled).toBe(false);
    expect(picked.result?.preview.totalRows).toBe(3);
    expect(picked.result?.preview.validRows).toBe(2);
    expect(picked.result?.preview.rejectedRows).toBe(1);
    expect(picked.result?.preview.detectedColumns).toEqual([
      "name",
      "url",
      "username",
      "password"
    ]);
    expect(JSON.stringify(picked)).not.toContain(PASSWORD);
  });

  it("writes ciphertext that contains no plaintext value", async () => {
    const manager = managerWith();
    chosenFile = join(root, "passwords.csv");
    writeFileSync(chosenFile, CSV_EXPORT);

    const picked = await manager.pickPasswordCsv();
    manager.commit(commit({ passwordHandle: picked.result?.handle ?? "", stagePasswords: true }));

    const bytes = readFileSync(join(userData, "staged-passwords.enc"));
    for (const encoding of ["utf8", "latin1", "base64", "hex"] as const) {
      expect(bytes.toString(encoding)).not.toContain(PASSWORD);
    }
  });

  it("stages nothing and says why when the system cannot encrypt", async () => {
    const manager = managerWith({ encryption: "unavailable" });
    chosenFile = join(root, "passwords.csv");
    writeFileSync(chosenFile, CSV_EXPORT);

    const picked = await manager.pickPasswordCsv();
    const result = manager.commit(
      commit({ passwordHandle: picked.result?.handle ?? "", stagePasswords: true })
    );

    expect(result.stagedPasswordCount).toBe(0);
    expect(result.warnings.map((warning) => warning.code)).toContain("encryption-unavailable");
    // Refusal, not a plaintext fallback.
    expect(existsSync(join(userData, "staged-passwords.enc"))).toBe(false);
  });

  it("reports the same refusal when there is no keyring to trust", () => {
    expect(managerWith({ encryption: "no-keyring" }).overview().encryption).toBe("no-keyring");
  });

  it("deletes every staged entry on request", async () => {
    const manager = managerWith();
    chosenFile = join(root, "passwords.csv");
    writeFileSync(chosenFile, CSV_EXPORT);

    const picked = await manager.pickPasswordCsv();
    manager.commit(commit({ passwordHandle: picked.result?.handle ?? "", stagePasswords: true }));
    expect(manager.overview().stagedPasswordCount).toBe(2);

    const after = manager.deleteStagedPasswords();

    expect(after.stagedPasswordCount).toBe(0);
    expect(after.state.stagedPasswords).toBe(false);
    expect(existsSync(join(userData, "staged-passwords.enc"))).toBe(false);
  });
});

describe("manual export files", () => {
  it("parses a chosen HTML export", async () => {
    const manager = managerWith();
    chosenFile = join(root, "export.html");
    writeFileSync(chosenFile, HTML_EXPORT);

    const picked = await manager.pickHtmlBookmarks("firefox-html");

    expect(picked.cancelled).toBe(false);
    expect(picked.result?.kind).toBe("firefox-html");
    expect(picked.result?.preview.bookmarkCount).toBe(2);
    // An HTML export carries no search configuration, and none is invented.
    expect(picked.result?.defaultSearchName).toBeNull();
    expect(JSON.stringify(picked)).not.toContain(root);
  });

  it("treats a dismissed dialog as an ordinary outcome", async () => {
    const manager = managerWith();
    chosenFile = null;

    const bookmarks = await manager.pickHtmlBookmarks("safari-html");
    const passwords = await manager.pickPasswordCsv();

    expect(bookmarks).toEqual({ cancelled: true, result: null });
    expect(passwords).toEqual({ cancelled: true, result: null });
    expect(dialogCalls).toBe(2);
  });

  it("checks the extension again after the dialog returns", async () => {
    const manager = managerWith();
    chosenFile = join(root, "places.sqlite");
    writeFileSync(chosenFile, "SQLite format 3 ");

    const picked = await manager.pickHtmlBookmarks("firefox-html");

    expect(picked.result?.preview.bookmarkCount).toBe(0);
    expect(picked.result?.preview.warnings.map((warning) => warning.code)).toContain(
      "file-malformed"
    );
  });
});

describe("wizard lifecycle", () => {
  it("cancelling drops every reviewed selection and writes no state", async () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });

    chosenFile = join(root, "passwords.csv");
    writeFileSync(chosenFile, CSV_EXPORT);
    const picked = await manager.pickPasswordCsv();

    manager.cancel();

    // Both handles are gone, so neither review can be committed after the fact.
    expect(() =>
      manager.commit(commit({ bookmarkHandle: review.handle, importBookmarks: true }))
    ).toThrow("no longer available");
    expect(() =>
      manager.commit(
        commit({ passwordHandle: picked.result?.handle ?? "", stagePasswords: true })
      )
    ).toThrow("no longer available");

    // A cancelled wizard is indistinguishable from one that was never opened.
    expect(existsSync(join(userData, "migration.json"))).toBe(false);
    expect(existsSync(join(userData, "bookmarks.json"))).toBe(false);
    expect(existsSync(join(userData, "staged-passwords.enc"))).toBe(false);
    expect(manager.overview().state.status).toBe("pending");
  });

  it("leaves no temporary file behind at any point", async () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });
    manager.commit(
      commit({
        sourceId: "google-chrome",
        profileId: "default",
        bookmarkHandle: review.handle,
        importBookmarks: true
      })
    );
    manager.finish();

    expect(readdirSync(userData).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("releases one selection on a step back", () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });

    manager.releaseHandle(review.handle);

    expect(() =>
      manager.commit(commit({ bookmarkHandle: review.handle, importBookmarks: true }))
    ).toThrow("no longer available");
  });

  it("expires a selection that was reviewed but never acted on", () => {
    let clock = 1_000;
    const manager = new MigrationManager({
      userDataDir: userData,
      cipher: bufferCipher(),
      environment: { platform: "linux", homeDir: home, localAppData: "", roamingAppData: "" },
      dialog,
      now: () => clock
    });

    const profile = join(home, ".config", "google-chrome", "Default");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "Bookmarks"), CHROMIUM_BOOKMARKS);

    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });
    clock += 16 * 60 * 1000;

    expect(() =>
      manager.commit(commit({ bookmarkHandle: review.handle, importBookmarks: true }))
    ).toThrow("no longer available");
  });

  it("records a fresh start as dismissed, having imported nothing", () => {
    const manager = managerWith();
    const overview = manager.startFresh();

    expect(overview.state.status).toBe("dismissed");
    expect(overview.state.runCount).toBe(0);
    expect(overview.storedBookmarkCount).toBe(0);
    expect(existsSync(join(userData, "bookmarks.json"))).toBe(false);
  });

  it("offers itself again from Settings", () => {
    const manager = managerWith();
    manager.startFresh();

    expect(manager.reopen().state.status).toBe("pending");
  });

  it("drops reviewed data at teardown", () => {
    const manager = managerWith();
    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });

    manager.destroy();

    expect(() =>
      manager.commit(commit({ bookmarkHandle: review.handle, importBookmarks: true }))
    ).toThrow("no longer available");
  });
});

describe("source directories", () => {
  it("never writes into the source browser's directory", () => {
    const manager = managerWith();
    const before = readdirSync(join(home, ".config", "google-chrome", "Default")).sort();

    const review = manager.previewChromiumProfile({ sourceId: "google-chrome", profileId: "default" });
    manager.commit(
      commit({
        sourceId: "google-chrome",
        profileId: "default",
        bookmarkHandle: review.handle,
        importBookmarks: true
      })
    );

    expect(readdirSync(join(home, ".config", "google-chrome", "Default")).sort()).toEqual(before);
    expect(readFileSync(join(home, ".config", "google-chrome", "Default", "Bookmarks"), "utf8")).toBe(
      CHROMIUM_BOOKMARKS
    );
  });
});
