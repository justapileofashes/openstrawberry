/**
 * The migration wizard's state machine.
 *
 * Kept apart from the component for the usual reason — a reducer is testable and
 * a tree of JSX is not — but also for a specific one: the rules about *when*
 * something may be read are expressed here, as transitions, rather than being
 * scattered through event handlers where a later edit could quietly skip one.
 *
 * Two invariants this module exists to hold:
 *
 *   - No category is ever on by default beyond what the chosen source can do,
 *     and a source with no readable bookmarks cannot arrive at a state where
 *     importing bookmarks is selected.
 *   - Nothing advances to a read until a path and, where one exists, a profile
 *     have been chosen; and nothing commits until the confirm step has been
 *     passed deliberately.
 *
 * The preview data this holds is bounded and short-lived. `resetReviews` drops
 * it whenever the user steps back or leaves, which is what pairs with the
 * trusted process releasing the handle.
 */

import type {
  BookmarkPreviewResponse,
  DetectedBrowser,
  DetectedProfile,
  MigrationCommitPayload,
  MigrationOverview,
  MigrationResult,
  PasswordPreviewResponse
} from "../shared/migration.js";
import type { EncryptionState } from "../shared/agents.js";

/* ------------------------------------------------------------------------- */
/* Shape                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The six screens, in order.
 *
 * `source` covers both halves of "what shall I read": which profile, and which
 * categories. Both are answerable from detection alone, which is what lets the
 * first actual read happen on the way to `preview` rather than before it.
 */
export const WIZARD_STEPS = [
  "welcome",
  "path",
  "source",
  "preview",
  "confirm",
  "result"
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_PATHS = [
  "fresh",
  "chromium",
  "firefox-html",
  "safari-html",
  "password-csv"
] as const;
export type WizardPath = (typeof WIZARD_PATHS)[number];

export type WizardStatus = "idle" | "working" | "error";

export type CategoryKey = "bookmarks" | "searchName" | "passwords";

export interface WizardState {
  readonly step: WizardStep;
  readonly path: WizardPath | null;
  readonly sourceId: string | null;
  readonly profileId: string | null;
  readonly importBookmarks: boolean;
  readonly importDefaultSearchName: boolean;
  readonly stagePasswords: boolean;
  readonly deduplicate: boolean;
  readonly bookmarkReview: BookmarkPreviewResponse | null;
  readonly passwordReview: PasswordPreviewResponse | null;
  readonly result: MigrationResult | null;
  readonly status: WizardStatus;
  /** A message already safe to show: it came back redacted from the router. */
  readonly errorMessage: string | null;
}

export function initialWizardState(): WizardState {
  return {
    step: "welcome",
    path: null,
    sourceId: null,
    profileId: null,
    importBookmarks: false,
    importDefaultSearchName: false,
    stagePasswords: false,
    // On by default because the destructive alternative is silent: a second run
    // with this off doubles every bookmark, and nothing about the result screen
    // would make that obvious afterwards.
    deduplicate: true,
    bookmarkReview: null,
    passwordReview: null,
    result: null,
    status: "idle",
    errorMessage: null
  };
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/* ------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* ------------------------------------------------------------------------- */

export function findBrowser(
  overview: MigrationOverview,
  sourceId: string | null
): DetectedBrowser | null {
  if (sourceId === null) return null;
  return overview.sources.find((browser) => browser.id === sourceId) ?? null;
}

export function findProfile(
  overview: MigrationOverview,
  sourceId: string | null,
  profileId: string | null
): DetectedProfile | null {
  if (profileId === null) return null;
  const browser = findBrowser(overview, sourceId);
  return browser?.profiles.find((profile) => profile.id === profileId) ?? null;
}

/**
 * Whether staging may be offered at all.
 *
 * The two failure states are distinguished deliberately: a machine with no
 * keyring is a fixable situation the user can act on, and telling them only that
 * "encryption is unavailable" would send them looking in the wrong place.
 */
export function passwordStagingAvailable(encryption: EncryptionState): boolean {
  return encryption === "available";
}

export function encryptionExplanation(encryption: EncryptionState): string | null {
  if (encryption === "available") return null;
  if (encryption === "no-keyring") {
    return "No system keyring is available, so anything stored here would be protected by a key anyone could read. OpenStrawberry will not stage passwords rather than store them unprotected.";
  }
  return "This system offers no operating-system encryption, so OpenStrawberry will not stage passwords rather than store them unprotected.";
}

/* ------------------------------------------------------------------------- */
/* Category availability                                                      */
/* ------------------------------------------------------------------------- */

export interface CategoryAvailability {
  readonly bookmarks: boolean;
  readonly searchName: boolean;
  readonly passwords: boolean;
}

/**
 * Which categories the chosen source could offer.
 *
 * Answered from detection, never from a file: a profile advertises whether the
 * files exist, and that is enough to decide what to *offer*. Reading them is a
 * later step the user has to reach.
 */
export function categoryAvailability(
  state: WizardState,
  overview: MigrationOverview
): CategoryAvailability {
  if (state.path === "chromium") {
    const profile = findProfile(overview, state.sourceId, state.profileId);
    return {
      bookmarks: profile?.supportsBookmarkRead ?? false,
      searchName: profile?.supportsSearchNameRead ?? false,
      passwords: false
    };
  }

  if (state.path === "firefox-html" || state.path === "safari-html") {
    return { bookmarks: true, searchName: false, passwords: false };
  }

  if (state.path === "password-csv") {
    return {
      bookmarks: false,
      searchName: false,
      passwords: passwordStagingAvailable(overview.encryption)
    };
  }

  return { bookmarks: false, searchName: false, passwords: false };
}

/* ------------------------------------------------------------------------- */
/* Transitions                                                                */
/* ------------------------------------------------------------------------- */

function resetReviews(state: WizardState): WizardState {
  return {
    ...state,
    bookmarkReview: null,
    passwordReview: null,
    result: null,
    status: "idle",
    errorMessage: null
  };
}

export function beginPath(
  state: WizardState,
  path: WizardPath,
  overview: MigrationOverview
): WizardState {
  const base: WizardState = {
    ...resetReviews(state),
    path,
    step: "source",
    sourceId: null,
    profileId: null,
    importBookmarks: false,
    importDefaultSearchName: false,
    stagePasswords: false
  };

  if (path === "firefox-html" || path === "safari-html") {
    // The only category the format carries. Selecting it here is not a default
    // applied on the user's behalf: choosing this path *is* choosing bookmarks.
    return { ...base, importBookmarks: true };
  }

  if (path === "password-csv") {
    return { ...base, stagePasswords: passwordStagingAvailable(overview.encryption) };
  }

  return base;
}

/**
 * Names a profile, and offers the categories that profile can actually provide.
 *
 * Selecting a profile pre-selects nothing beyond what it supports, and a profile
 * with no bookmark file cannot leave `importBookmarks` set from a previous
 * selection — which is the case a stale toggle would otherwise sail through.
 */
export function chooseProfile(
  state: WizardState,
  sourceId: string,
  profileId: string,
  overview: MigrationOverview
): WizardState {
  const next: WizardState = { ...resetReviews(state), sourceId, profileId };
  const available = categoryAvailability(next, overview);

  return {
    ...next,
    importBookmarks: available.bookmarks,
    importDefaultSearchName: false,
    stagePasswords: false
  };
}

export function toggleCategory(
  state: WizardState,
  category: CategoryKey,
  overview: MigrationOverview
): WizardState {
  const available = categoryAvailability(state, overview);

  if (category === "bookmarks" && available.bookmarks) {
    return { ...state, importBookmarks: !state.importBookmarks };
  }
  if (category === "searchName" && available.searchName) {
    return { ...state, importDefaultSearchName: !state.importDefaultSearchName };
  }
  if (category === "passwords" && available.passwords) {
    return { ...state, stagePasswords: !state.stagePasswords };
  }

  // An unavailable category is not toggled into existence by asking twice.
  return state;
}

export function setDeduplicate(state: WizardState, deduplicate: boolean): WizardState {
  return { ...state, deduplicate };
}

/** Whether the source step has enough to justify reading anything. */
export function canReadSource(state: WizardState): boolean {
  if (state.status === "working") return false;

  if (state.path === "chromium") {
    if (state.sourceId === null || state.profileId === null) return false;
    return state.importBookmarks || state.importDefaultSearchName;
  }

  if (state.path === "firefox-html" || state.path === "safari-html") {
    return state.importBookmarks;
  }

  if (state.path === "password-csv") return state.stagePasswords;

  return false;
}

export function withWorking(state: WizardState): WizardState {
  return { ...state, status: "working", errorMessage: null };
}

export function withError(state: WizardState, message: string): WizardState {
  return { ...state, status: "error", errorMessage: message };
}

export function withBookmarkReview(
  state: WizardState,
  review: BookmarkPreviewResponse
): WizardState {
  return {
    ...state,
    step: "preview",
    status: "idle",
    errorMessage: null,
    bookmarkReview: review,
    // A source that turned out to hold nothing importable cannot carry the
    // category forward, however it was selected a screen ago.
    importBookmarks: state.importBookmarks && review.preview.bookmarkCount > 0,
    importDefaultSearchName:
      state.importDefaultSearchName && review.defaultSearchName !== null
  };
}

export function withPasswordReview(
  state: WizardState,
  review: PasswordPreviewResponse
): WizardState {
  return {
    ...state,
    step: "preview",
    status: "idle",
    errorMessage: null,
    passwordReview: review,
    stagePasswords: state.stagePasswords && review.preview.validRows > 0
  };
}

export function withResult(state: WizardState, result: MigrationResult): WizardState {
  return { ...state, step: "result", status: "idle", errorMessage: null, result };
}

/** Whether the preview found anything the confirm step could act on. */
export function hasSomethingToImport(state: WizardState): boolean {
  return state.importBookmarks || state.importDefaultSearchName || state.stagePasswords;
}

export function goToConfirm(state: WizardState): WizardState {
  if (!hasSomethingToImport(state)) return state;
  return { ...state, step: "confirm", status: "idle", errorMessage: null };
}

/**
 * Steps back one screen.
 *
 * Leaving the preview drops the reviewed data, which is the renderer half of
 * releasing the handle in the trusted process. A user who steps back and forward
 * again reads the source afresh rather than confirming a stale review.
 */
export function stepBack(state: WizardState): WizardState {
  switch (state.step) {
    case "path":
      return { ...resetReviews(state), step: "welcome", path: null };
    case "source":
      return { ...resetReviews(state), step: "path", path: null };
    case "preview":
      return { ...resetReviews(state), step: "source" };
    case "confirm":
      return { ...state, step: "preview", status: "idle", errorMessage: null };
    default:
      return state;
  }
}

/** The handle the trusted process should be told to forget on a step back. */
export function handleToRelease(state: WizardState): string | null {
  if (state.step !== "preview") return null;
  return state.bookmarkReview?.handle ?? state.passwordReview?.handle ?? null;
}

/* ------------------------------------------------------------------------- */
/* Commit                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Builds the commit request, or null when the state cannot justify one.
 *
 * Returning null rather than a partial request is deliberate: the trusted
 * process rejects an inconsistent payload anyway, and a wizard that can only
 * produce valid requests never has to render that rejection.
 */
export function commitRequest(state: WizardState): MigrationCommitPayload | null {
  if (state.step !== "confirm") return null;
  if (!hasSomethingToImport(state)) return null;

  const wantsBookmarkFile = state.importBookmarks || state.importDefaultSearchName;
  const bookmarkHandle = wantsBookmarkFile ? (state.bookmarkReview?.handle ?? null) : null;
  const passwordHandle = state.stagePasswords ? (state.passwordReview?.handle ?? null) : null;

  if (wantsBookmarkFile && bookmarkHandle === null) return null;
  if (state.stagePasswords && passwordHandle === null) return null;

  return {
    sourceId: bookmarkHandle === null ? null : state.sourceId,
    profileId: bookmarkHandle === null ? null : state.profileId,
    bookmarkHandle,
    passwordHandle,
    importBookmarks: state.importBookmarks,
    importDefaultSearchName: state.importDefaultSearchName,
    stagePasswords: state.stagePasswords,
    deduplicate: state.deduplicate
  };
}

/* ------------------------------------------------------------------------- */
/* Copy                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * What this migration will not touch, stated plainly on the review screen.
 *
 * The list is fixed rather than derived, because it is a promise about the whole
 * application and not a description of one code path. Everything on it is a
 * category OpenStrawberry has no code to read.
 */
export const NEVER_IMPORTED: readonly string[] = [
  "Cookies and active sign-ins",
  "Session and account tokens",
  "Passkeys and payment methods",
  "Extensions, extension data, and their settings",
  "Browsing and download history",
  "Autofill entries and form data"
];

/** What a given path additionally cannot offer, and why. */
export function pathLimitations(path: WizardPath | null): readonly string[] {
  switch (path) {
    case "chromium":
      return [
        "Saved passwords are not read from the browser's own store. Export them to a CSV and use the password path if you want them staged."
      ];
    case "firefox-html":
    case "safari-html":
      return [
        "Only the exported file is read. OpenStrawberry never opens places.sqlite, Safari's bookmark database, or any other internal browser file.",
        "An HTML export carries bookmarks only — no search settings, passwords, or history."
      ];
    case "password-csv":
      return [
        "Staged entries are stored encrypted and are never filled in automatically. Nothing is synced, and the values cannot be shown again after staging.",
        "No agent or web page can reach a staged entry."
      ];
    default:
      return [];
  }
}

/** How a user produces the export file this path needs. */
export function exportInstructions(path: WizardPath | null): readonly string[] {
  if (path === "firefox-html") {
    return [
      "In Firefox, open the menu and choose Bookmarks, then Manage bookmarks.",
      "In the Library window, choose Import and Backup, then Export Bookmarks to HTML.",
      "Save the file somewhere you can find it, then choose it below."
    ];
  }

  if (path === "safari-html") {
    return [
      "In Safari, choose File, then Export, then Bookmarks.",
      "Save the file somewhere you can find it, then choose it below."
    ];
  }

  if (path === "password-csv") {
    return [
      "Export your passwords from your current browser or password manager as a CSV file.",
      "Choose the file below. It is read once, on this machine, and is never copied or uploaded.",
      "Delete the exported CSV yourself afterwards: it is an unencrypted file of your passwords."
    ];
  }

  return [];
}
