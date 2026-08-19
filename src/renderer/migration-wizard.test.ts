import { describe, expect, it } from "vitest";
import {
  NEVER_IMPORTED,
  beginPath,
  canReadSource,
  categoryAvailability,
  chooseProfile,
  commitRequest,
  encryptionExplanation,
  exportInstructions,
  goToConfirm,
  handleToRelease,
  hasSomethingToImport,
  initialWizardState,
  passwordStagingAvailable,
  pathLimitations,
  setDeduplicate,
  stepBack,
  toggleCategory,
  withBookmarkReview,
  withError,
  withPasswordReview,
  withResult,
  withWorking,
  type WizardState
} from "./migration-wizard.js";
import {
  emptyMigrationState,
  emptyResult,
  type BookmarkPreviewResponse,
  type MigrationOverview,
  type PasswordPreviewResponse
} from "../shared/migration.js";
import type { EncryptionState } from "../shared/agents.js";

function overviewWith(options: {
  readonly encryption?: EncryptionState;
  readonly bookmarks?: boolean;
  readonly preferences?: boolean;
  readonly sources?: boolean;
} = {}): MigrationOverview {
  return {
    state: emptyMigrationState(),
    encryption: options.encryption ?? "available",
    sources:
      options.sources === false
        ? []
        : [
            {
              id: "google-chrome",
              displayName: "Google Chrome",
              family: "chromium",
              profiles: [
                {
                  id: "default",
                  displayName: "Personal",
                  supportsBookmarkRead: options.bookmarks ?? true,
                  supportsSearchNameRead: options.preferences ?? true
                }
              ]
            }
          ],
    stagedPasswordCount: 0,
    storedBookmarkCount: 0
  };
}

function bookmarkReview(bookmarkCount: number, searchName: string | null = "DuckDuckGo"): BookmarkPreviewResponse {
  return {
    handle: "mig-book-1",
    kind: "chromium",
    preview: { folderCount: 2, bookmarkCount, sample: [], warnings: [] },
    defaultSearchName: searchName
  };
}

function passwordReview(validRows: number): PasswordPreviewResponse {
  return {
    handle: "mig-pass-1",
    preview: {
      totalRows: validRows + 1,
      validRows,
      rejectedRows: 1,
      detectedColumns: ["url", "username", "password"],
      warnings: []
    }
  };
}

/** Walks a chromium migration to the confirm step. */
function atConfirm(overview = overviewWith()): WizardState {
  let state = beginPath(initialWizardState(), "chromium", overview);
  state = chooseProfile(state, "google-chrome", "default", overview);
  state = withBookmarkReview(state, bookmarkReview(12));
  return goToConfirm(state);
}

describe("initial state", () => {
  it("starts on the welcome screen with every category off", () => {
    const state = initialWizardState();

    expect(state.step).toBe("welcome");
    expect(state.path).toBeNull();
    expect(hasSomethingToImport(state)).toBe(false);
    expect(commitRequest(state)).toBeNull();
  });

  it("defaults to skipping bookmarks already saved", () => {
    // The destructive alternative is silent, so the safe option is the default.
    expect(initialWizardState().deduplicate).toBe(true);
  });
});

describe("beginPath", () => {
  it("selects nothing on its own for a detected browser", () => {
    const state = beginPath(initialWizardState(), "chromium", overviewWith());

    expect(state.step).toBe("source");
    expect(state.importBookmarks).toBe(false);
    expect(state.importDefaultSearchName).toBe(false);
    expect(state.stagePasswords).toBe(false);
    expect(canReadSource(state)).toBe(false);
  });

  it("selects bookmarks for an export path, because that is the whole format", () => {
    for (const path of ["firefox-html", "safari-html"] as const) {
      const state = beginPath(initialWizardState(), path, overviewWith());
      expect(state.importBookmarks).toBe(true);
      expect(state.stagePasswords).toBe(false);
      expect(canReadSource(state)).toBe(true);
    }
  });

  it("cannot select password staging when the system cannot encrypt", () => {
    for (const encryption of ["unavailable", "no-keyring"] as const) {
      const state = beginPath(initialWizardState(), "password-csv", overviewWith({ encryption }));
      expect(state.stagePasswords).toBe(false);
      expect(canReadSource(state)).toBe(false);
    }

    const usable = beginPath(initialWizardState(), "password-csv", overviewWith());
    expect(usable.stagePasswords).toBe(true);
    expect(canReadSource(usable)).toBe(true);
  });
});

describe("category availability", () => {
  it("offers only what the chosen profile can provide", () => {
    const overview = overviewWith({ preferences: false });
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);

    expect(categoryAvailability(state, overview)).toEqual({
      bookmarks: true,
      searchName: false,
      passwords: false
    });
    expect(state.importBookmarks).toBe(true);
    expect(state.importDefaultSearchName).toBe(false);
  });

  it("cannot select a category the profile does not support", () => {
    const overview = overviewWith({ bookmarks: false, preferences: false });
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);

    expect(state.importBookmarks).toBe(false);

    state = toggleCategory(state, "bookmarks", overview);
    state = toggleCategory(state, "searchName", overview);
    state = toggleCategory(state, "passwords", overview);

    expect(hasSomethingToImport(state)).toBe(false);
    expect(canReadSource(state)).toBe(false);
  });

  it("never offers password staging alongside a browser profile", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);

    expect(categoryAvailability(state, overview).passwords).toBe(false);
    expect(toggleCategory(state, "passwords", overview).stagePasswords).toBe(false);
  });

  it("clears a stale selection when the profile changes", () => {
    const permissive = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", permissive);
    state = chooseProfile(state, "google-chrome", "default", permissive);
    state = toggleCategory(state, "searchName", permissive);
    expect(state.importDefaultSearchName).toBe(true);

    const restricted = overviewWith({ bookmarks: false, preferences: false });
    state = chooseProfile(state, "google-chrome", "default", restricted);

    expect(state.importBookmarks).toBe(false);
    expect(state.importDefaultSearchName).toBe(false);
  });
});

describe("reading a source", () => {
  it("will not read before a profile and a category are chosen", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    expect(canReadSource(state)).toBe(false);

    state = chooseProfile(state, "google-chrome", "default", overview);
    expect(canReadSource(state)).toBe(true);

    state = toggleCategory(state, "bookmarks", overview);
    expect(state.importBookmarks).toBe(false);
    expect(canReadSource(state)).toBe(false);
  });

  it("will not read while a read is already running", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);

    expect(canReadSource(withWorking(state))).toBe(false);
  });
});

describe("review outcomes", () => {
  it("drops a category the source turned out not to hold", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);
    state = toggleCategory(state, "searchName", overview);

    state = withBookmarkReview(state, bookmarkReview(0, null));

    expect(state.step).toBe("preview");
    expect(state.importBookmarks).toBe(false);
    expect(state.importDefaultSearchName).toBe(false);
    expect(hasSomethingToImport(state)).toBe(false);
    // Nothing to confirm means the confirm step is not reachable.
    expect(goToConfirm(state).step).toBe("preview");
  });

  it("drops password staging when nothing in the file was usable", () => {
    let state = beginPath(initialWizardState(), "password-csv", overviewWith());
    state = withPasswordReview(state, passwordReview(0));

    expect(state.stagePasswords).toBe(false);
    expect(commitRequest(goToConfirm(state))).toBeNull();
  });

  it("keeps a category the source does hold", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);
    state = toggleCategory(state, "searchName", overview);
    state = withBookmarkReview(state, bookmarkReview(12));

    expect(state.importBookmarks).toBe(true);
    expect(state.importDefaultSearchName).toBe(true);
  });
});

describe("commitRequest", () => {
  it("is null everywhere except the confirm step", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);
    state = withBookmarkReview(state, bookmarkReview(12));

    expect(state.step).toBe("preview");
    expect(commitRequest(state)).toBeNull();
    expect(commitRequest(goToConfirm(state))).not.toBeNull();
  });

  it("carries handles and identifiers, never a path", () => {
    const request = commitRequest(atConfirm());

    expect(request).toEqual({
      sourceId: "google-chrome",
      profileId: "default",
      bookmarkHandle: "mig-book-1",
      passwordHandle: null,
      importBookmarks: true,
      importDefaultSearchName: false,
      stagePasswords: false,
      deduplicate: true
    });
  });

  it("omits the source when the review came from a chosen file", () => {
    let state = beginPath(initialWizardState(), "firefox-html", overviewWith());
    state = withBookmarkReview(state, {
      ...bookmarkReview(4, null),
      kind: "firefox-html"
    });

    const request = commitRequest(goToConfirm(state));

    expect(request?.sourceId).toBeNull();
    expect(request?.profileId).toBeNull();
    expect(request?.bookmarkHandle).toBe("mig-book-1");
  });

  it("sends a password handle only when staging is selected", () => {
    let state = beginPath(initialWizardState(), "password-csv", overviewWith());
    state = withPasswordReview(state, passwordReview(5));
    const request = commitRequest(goToConfirm(state));

    expect(request?.passwordHandle).toBe("mig-pass-1");
    expect(request?.bookmarkHandle).toBeNull();
    expect(request?.importBookmarks).toBe(false);
  });

  it("carries the deduplication choice through", () => {
    const request = commitRequest(setDeduplicate(atConfirm(), false));
    expect(request?.deduplicate).toBe(false);
  });

  it("refuses to build a request with no reviewed file", () => {
    const state: WizardState = { ...atConfirm(), bookmarkReview: null };
    expect(commitRequest(state)).toBeNull();
  });
});

describe("stepping back and cancelling", () => {
  it("names the handle to release when leaving a review", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);
    state = withBookmarkReview(state, bookmarkReview(12));

    expect(handleToRelease(state)).toBe("mig-book-1");
    expect(handleToRelease(stepBack(state))).toBeNull();
  });

  it("discards reviewed data on the way back, so nothing stale is confirmed", () => {
    const overview = overviewWith();
    let state = beginPath(initialWizardState(), "chromium", overview);
    state = chooseProfile(state, "google-chrome", "default", overview);
    state = withBookmarkReview(state, bookmarkReview(12));

    const back = stepBack(state);

    expect(back.step).toBe("source");
    expect(back.bookmarkReview).toBeNull();
    expect(back.passwordReview).toBeNull();
  });

  it("keeps the review when stepping back from confirm to preview", () => {
    const back = stepBack(atConfirm());

    expect(back.step).toBe("preview");
    expect(back.bookmarkReview).not.toBeNull();
  });

  it("walks all the way back to the welcome screen", () => {
    let state = atConfirm();
    for (let index = 0; index < 5; index += 1) state = stepBack(state);

    expect(state.step).toBe("welcome");
    expect(state.path).toBeNull();
    expect(state.bookmarkReview).toBeNull();
  });
});

describe("error and result states", () => {
  it("keeps the user on the same screen after a failure", () => {
    const state = withError(atConfirm(), "The request could not be completed.");

    expect(state.step).toBe("confirm");
    expect(state.status).toBe("error");
    expect(state.errorMessage).toBe("The request could not be completed.");
    // The escape routes are still reachable: back, and start fresh.
    expect(stepBack(state).step).toBe("preview");
  });

  it("clears an earlier failure when work restarts", () => {
    const state = withWorking(withError(atConfirm(), "boom"));

    expect(state.status).toBe("working");
    expect(state.errorMessage).toBeNull();
  });

  it("lands on the result screen with counts", () => {
    const state = withResult(atConfirm(), {
      ...emptyResult(),
      importedBookmarkCount: 12,
      importedFolderCount: 2
    });

    expect(state.step).toBe("result");
    expect(state.result?.importedBookmarkCount).toBe(12);
  });
});

describe("copy", () => {
  it("states the never-imported categories on every path", () => {
    const text = NEVER_IMPORTED.join(" ").toLowerCase();

    for (const category of ["cookie", "token", "passkey", "payment", "extension", "history"]) {
      expect(text).toContain(category);
    }
  });

  it("says plainly that internal browser databases are never opened", () => {
    const firefox = pathLimitations("firefox-html").join(" ");
    expect(firefox).toContain("places.sqlite");
    expect(firefox.toLowerCase()).toContain("never opens");
  });

  it("says staged passwords are never filled in automatically", () => {
    const text = pathLimitations("password-csv").join(" ").toLowerCase();
    expect(text).toContain("never filled in automatically");
    expect(text).toContain("agent");
  });

  it("gives export instructions for every manual path and none for a detected one", () => {
    expect(exportInstructions("firefox-html").length).toBeGreaterThan(0);
    expect(exportInstructions("safari-html").length).toBeGreaterThan(0);
    expect(exportInstructions("password-csv").length).toBeGreaterThan(0);
    expect(exportInstructions("chromium")).toEqual([]);
  });

  it("explains an unusable encryption state instead of hiding the control silently", () => {
    expect(encryptionExplanation("available")).toBeNull();
    expect(encryptionExplanation("no-keyring")).toContain("keyring");
    expect(encryptionExplanation("unavailable")).toContain("encryption");
    expect(passwordStagingAvailable("available")).toBe(true);
    expect(passwordStagingAvailable("no-keyring")).toBe(false);
  });
});

describe("no-source flow", () => {
  it("stays usable when nothing was detected", () => {
    const overview = overviewWith({ sources: false });
    const state = beginPath(initialWizardState(), "firefox-html", overview);

    // The export and fresh paths do not depend on detection finding anything.
    expect(canReadSource(state)).toBe(true);
    expect(categoryAvailability(state, overview).bookmarks).toBe(true);
  });
});
