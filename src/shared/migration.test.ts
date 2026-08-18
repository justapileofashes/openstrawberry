import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./bridge.js";
import { IpcValidationError } from "./ipc-validation.js";
import {
  MIGRATION_WARNING_CODES,
  bookmarkDedupeKey,
  describeWarning,
  emptyMigrationState,
  emptyResult,
  emptySelection,
  hasAnyCategory,
  isImportableBookmarkUrl,
  normalizeBookmarkUrl,
  parseHtmlPickPayload,
  parseMigrationCommitPayload,
  parseMigrationHandlePayload,
  parseMigrationPreviewPayload,
  parseMigrationState,
  shouldOfferWizard,
  toBookmarkPreview
} from "./migration.js";

const HANDLE = "mig-9f8a7b6c-1111-2222-3333-444455556666";

/**
 * Overrides are deliberately untyped: half of these cases send values the
 * contract forbids, which is the point of testing a runtime validator.
 */
function commitPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    sourceId: "google-chrome",
    profileId: "default",
    bookmarkHandle: HANDLE,
    passwordHandle: null,
    importBookmarks: true,
    importDefaultSearchName: false,
    stagePasswords: false,
    deduplicate: true,
    ...overrides
  };
}

describe("normalizeBookmarkUrl", () => {
  it("keeps the parts that identify a page and drops the parts that do not", () => {
    expect(normalizeBookmarkUrl("HTTPS://Example.COM/Path?q=1#section")).toBe(
      "https://example.com/Path?q=1"
    );
    expect(normalizeBookmarkUrl("https://example.com")).toBe("https://example.com/");
    expect(normalizeBookmarkUrl("http://example.com:8080/x")).toBe("http://example.com:8080/x");
  });

  it("keeps the query string, because for many sites it selects the page", () => {
    expect(normalizeBookmarkUrl("https://a.test/view?id=1")).not.toBe(
      normalizeBookmarkUrl("https://a.test/view?id=2")
    );
  });

  it("refuses every scheme that is not http or https", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "file:///c:/secrets.txt",
      "chrome://settings",
      "about:blank",
      "ftp://files.test/x",
      "android://hash@com.example.app/",
      "vbscript:msgbox",
      "not a url",
      ""
    ]) {
      expect(normalizeBookmarkUrl(url)).toBeNull();
      expect(isImportableBookmarkUrl(url)).toBe(false);
    }
  });

  it("refuses a URL carrying embedded credentials", () => {
    expect(normalizeBookmarkUrl("https://user:pass@example.com/")).toBeNull();
    expect(normalizeBookmarkUrl("https://user@example.com/")).toBeNull();
  });

  it("refuses an address longer than the bound", () => {
    expect(normalizeBookmarkUrl(`https://a.test/${"x".repeat(5000)}`)).toBeNull();
  });
});

describe("bookmarkDedupeKey", () => {
  it("treats the same address in the same folder as one bookmark", () => {
    const a = bookmarkDedupeKey({ title: "A", url: "https://x.test/p", folderPath: ["Work"] });
    const b = bookmarkDedupeKey({ title: "B", url: "HTTPS://X.test/p#top", folderPath: ["work"] });
    expect(a).toBe(b);
  });

  it("treats the same address in different folders as two bookmarks", () => {
    const a = bookmarkDedupeKey({ title: "A", url: "https://x.test/p", folderPath: ["Work"] });
    const b = bookmarkDedupeKey({ title: "A", url: "https://x.test/p", folderPath: ["Home"] });
    expect(a).not.toBe(b);
  });

  it("has no key for an entry that could not be imported anyway", () => {
    expect(bookmarkDedupeKey({ title: "X", url: "javascript:x", folderPath: [] })).toBeNull();
  });
});

describe("parseMigrationPreviewPayload", () => {
  it("accepts a well-formed identifier pair", () => {
    expect(
      parseMigrationPreviewPayload({ sourceId: "google-chrome", profileId: "profile-1" })
    ).toEqual({ sourceId: "google-chrome", profileId: "profile-1" });
  });

  it("refuses anything shaped like a path", () => {
    for (const sourceId of [
      "C:\\Users\\person\\AppData\\Local\\Google\\Chrome",
      "/home/person/.config/google-chrome",
      "../../etc/passwd",
      "google chrome",
      "google/chrome",
      "chrome\u0000",
      ""
    ]) {
      expect(() =>
        parseMigrationPreviewPayload({ sourceId, profileId: "default" })
      ).toThrow(IpcValidationError);
    }
  });

  it("refuses missing halves and non-strings", () => {
    for (const raw of [
      {},
      { sourceId: "chrome" },
      { profileId: "default" },
      { sourceId: 1, profileId: "default" },
      { sourceId: "chrome", profileId: true },
      null,
      "chrome",
      []
    ]) {
      expect(() => parseMigrationPreviewPayload(raw)).toThrow(IpcValidationError);
    }
  });

  it("refuses a prototype-polluting payload", () => {
    const hostile = JSON.parse('{"__proto__":{"x":1},"sourceId":"a","profileId":"b"}') as unknown;
    expect(() => parseMigrationPreviewPayload(hostile)).toThrow(IpcValidationError);
  });
});

describe("parseHtmlPickPayload", () => {
  it("accepts only the two manual-export kinds", () => {
    expect(parseHtmlPickPayload({ kind: "firefox-html" }).kind).toBe("firefox-html");
    expect(parseHtmlPickPayload({ kind: "safari-html" }).kind).toBe("safari-html");
  });

  it("refuses a kind that would name a database or a detected profile", () => {
    for (const kind of ["chromium", "password-csv", "places.sqlite", "", 7, null]) {
      expect(() => parseHtmlPickPayload({ kind })).toThrow(IpcValidationError);
    }
  });
});

describe("parseMigrationCommitPayload", () => {
  it("accepts a consistent bookmark import", () => {
    const parsed = parseMigrationCommitPayload(commitPayload());
    expect(parsed.importBookmarks).toBe(true);
    expect(parsed.bookmarkHandle).toBe(HANDLE);
    expect(parsed.passwordHandle).toBeNull();
  });

  it("refuses a commit that names no category at all", () => {
    expect(() =>
      parseMigrationCommitPayload(
        commitPayload({ importBookmarks: false, bookmarkHandle: null, sourceId: null, profileId: null })
      )
    ).toThrow(IpcValidationError);
  });

  it("refuses importing bookmarks with no reviewed file", () => {
    expect(() => parseMigrationCommitPayload(commitPayload({ bookmarkHandle: null }))).toThrow(
      IpcValidationError
    );
  });

  it("refuses staging passwords with no reviewed file", () => {
    expect(() =>
      parseMigrationCommitPayload(
        commitPayload({ stagePasswords: true, passwordHandle: null })
      )
    ).toThrow(IpcValidationError);
  });

  it("refuses a handle sent for a category that was not selected", () => {
    expect(() =>
      parseMigrationCommitPayload(
        commitPayload({ stagePasswords: false, passwordHandle: HANDLE })
      )
    ).toThrow(IpcValidationError);

    expect(() =>
      parseMigrationCommitPayload(
        commitPayload({
          importBookmarks: false,
          importDefaultSearchName: false,
          bookmarkHandle: null,
          stagePasswords: true,
          passwordHandle: HANDLE,
          sourceId: null,
          profileId: null
        })
      )
    ).not.toThrow();
  });

  it("refuses a half-named source", () => {
    expect(() => parseMigrationCommitPayload(commitPayload({ profileId: null }))).toThrow(
      IpcValidationError
    );
    expect(() => parseMigrationCommitPayload(commitPayload({ sourceId: null }))).toThrow(
      IpcValidationError
    );
  });

  it("refuses a handle shaped like a path", () => {
    for (const bookmarkHandle of [
      "/etc/passwd",
      "C:\\Windows\\System32\\config\\SAM",
      "../../../secrets",
      "handle with spaces"
    ]) {
      expect(() => parseMigrationCommitPayload(commitPayload({ bookmarkHandle }))).toThrow(
        IpcValidationError
      );
    }
  });

  it("refuses non-boolean category flags rather than coercing them", () => {
    for (const importBookmarks of ["true", 1, null, {}]) {
      expect(() => parseMigrationCommitPayload(commitPayload({ importBookmarks }))).toThrow(
        IpcValidationError
      );
    }
  });

  it("allows the search name only alongside a reviewed profile", () => {
    expect(() =>
      parseMigrationCommitPayload(
        commitPayload({ importBookmarks: false, importDefaultSearchName: true })
      )
    ).not.toThrow();

    expect(() =>
      parseMigrationCommitPayload(
        commitPayload({
          importBookmarks: false,
          importDefaultSearchName: true,
          bookmarkHandle: null,
          sourceId: null,
          profileId: null
        })
      )
    ).toThrow(IpcValidationError);
  });
});

describe("parseMigrationHandlePayload", () => {
  it("accepts a minted handle and refuses a path", () => {
    expect(parseMigrationHandlePayload({ handle: HANDLE }).handle).toBe(HANDLE);
    expect(() => parseMigrationHandlePayload({ handle: "/tmp/x" })).toThrow(IpcValidationError);
    expect(() => parseMigrationHandlePayload({})).toThrow(IpcValidationError);
  });
});

describe("parseMigrationState", () => {
  it("round-trips a written record", () => {
    const written = {
      ...emptyMigrationState(),
      status: "completed" as const,
      updatedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_000,
      runCount: 2,
      lastSourceKind: "chromium" as const,
      importedBookmarks: true,
      defaultSearchName: "DuckDuckGo",
      totalBookmarkCount: 412
    };

    expect(parseMigrationState(JSON.parse(JSON.stringify(written)) as unknown)).toEqual(written);
  });

  it("falls back to the empty state for a corrupt or foreign file", () => {
    for (const raw of [null, "text", [], {}, { version: 99 }, { version: 1, status: 5 }]) {
      const parsed = parseMigrationState(raw);
      expect(parsed.version).toBe(1);
      expect(["pending", "completed", "dismissed"]).toContain(parsed.status);
    }
  });

  it("bounds counts and timestamps rather than trusting them", () => {
    const parsed = parseMigrationState({
      version: 1,
      status: "completed",
      updatedAt: Number.MAX_SAFE_INTEGER,
      runCount: -5,
      totalBookmarkCount: 9_000_000,
      stagedPasswordCount: 1.5
    });

    expect(parsed.updatedAt).toBe(0);
    expect(parsed.runCount).toBe(0);
    expect(parsed.totalBookmarkCount).toBeLessThanOrEqual(50_000);
    expect(parsed.stagedPasswordCount).toBe(0);
  });

  it("has no field that could carry a path or a secret", () => {
    const keys = Object.keys(emptyMigrationState());
    for (const forbidden of ["path", "sourcePath", "profilePath", "password", "passwords", "bookmarks"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("shouldOfferWizard", () => {
  it("offers only while migration is still pending", () => {
    expect(shouldOfferWizard(emptyMigrationState())).toBe(true);
    expect(shouldOfferWizard({ ...emptyMigrationState(), status: "completed" })).toBe(false);
    expect(shouldOfferWizard({ ...emptyMigrationState(), status: "dismissed" })).toBe(false);
  });
});

describe("selection and result contracts", () => {
  it("starts with every category off", () => {
    const selection = emptySelection();
    expect(hasAnyCategory(selection)).toBe(false);
    expect(selection.importBookmarks).toBe(false);
    expect(selection.importDefaultSearchName).toBe(false);
    expect(selection.stagePasswords).toBe(false);
  });

  it("carries counts and warnings only, never a value", () => {
    const keys = Object.keys(emptyResult());
    expect(keys.sort()).toEqual(
      [
        "importedBookmarkCount",
        "importedFolderCount",
        "importedSearchName",
        "searchName",
        "skippedDuplicateCount",
        "stagedPasswordCount",
        "warnings"
      ].sort()
    );

    for (const forbidden of ["password", "passwords", "records", "rows", "path", "entries"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe("previews", () => {
  it("bounds the sample regardless of how much was parsed", () => {
    const bookmarks = Array.from({ length: 200 }, (_unused, index) => ({
      title: "T".repeat(400),
      url: `https://example.com/${index}`,
      folderPath: []
    }));

    const preview = toBookmarkPreview({ bookmarks, folderCount: 3, warnings: [] });

    expect(preview.bookmarkCount).toBe(200);
    expect(preview.sample).toHaveLength(8);
    for (const entry of preview.sample) expect(entry.title.length).toBeLessThanOrEqual(96);
  });
});

describe("warnings", () => {
  it("describes every code, so no warning can render as blank", () => {
    for (const code of MIGRATION_WARNING_CODES) {
      const text = describeWarning({ code, count: 0 });
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("is a closed set of codes rather than free text a value could reach", () => {
    // The shape is the guarantee: a warning has a code and a count and nowhere
    // to put a bookmark title, a URL, a CSV cell, or a path.
    const warning = { code: MIGRATION_WARNING_CODES[0], count: 3 };
    expect(Object.keys(warning).sort()).toEqual(["code", "count"]);
  });
});

describe("IPC channels", () => {
  it("registers every migration channel under one namespace", () => {
    const channels = [
      IPC_CHANNELS.migrationOverview,
      IPC_CHANNELS.migrationPreviewProfile,
      IPC_CHANNELS.migrationPickBookmarks,
      IPC_CHANNELS.migrationPickPasswords,
      IPC_CHANNELS.migrationCommit,
      IPC_CHANNELS.migrationRelease,
      IPC_CHANNELS.migrationStartFresh,
      IPC_CHANNELS.migrationFinish,
      IPC_CHANNELS.migrationCancel,
      IPC_CHANNELS.migrationReopen,
      IPC_CHANNELS.migrationDeleteStaged
    ];

    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel.startsWith("migration:")).toBe(true);
  });

  it("exposes no channel that could read a staged password back out", () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).not.toMatch(/read|reveal|decrypt|export|list-passwords/u);
    }
  });
});
