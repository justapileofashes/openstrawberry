/**
 * The update channel, and the gate in front of it.
 *
 * An updater is the most dangerous feature a desktop application has: it
 * downloads code and runs it. Everything here is arranged so that the dangerous
 * part cannot happen by default, and cannot be switched on by any single
 * mistake.
 *
 *   1. **The gate is a conjunction, not a flag.** Updating requires a packaged
 *      build *and* a release-ready product *and* an enabled channel. Any one of
 *      those being false is a refusal, so flipping one constant on its own
 *      changes nothing. `updateGate` returns *why* it refused rather than a
 *      boolean, so the chrome can say something true.
 *
 *   2. **Nothing happens without being asked.** There is no "check on launch"
 *      state. `idle` is the resting state of an enabled channel, and it moves
 *      only when a person presses something.
 *
 *   3. **Downloading and installing are separate acts.** A downloaded update
 *      sits in `downloaded` until the user restarts. An updater that installs
 *      what it fetched is one that decides when your work is interrupted.
 *
 * Pure ASCII, so the state set stays reviewable.
 */

import { requirePlainObject, requireString } from "./ipc-validation.js";

/** Bounds a version string read from release metadata. */
export const MAX_VERSION_LENGTH = 64;

/**
 * Why the update channel is off.
 *
 * Codes rather than prose, and each one names a different fix: a development
 * build is not the same problem as an unsigned release, and telling a user
 * "updates are unavailable" for both helps neither.
 */
export const UPDATE_BLOCKERS = [
  "not-packaged",
  "not-release-ready",
  "channel-disabled"
] as const;

export type UpdateBlocker = (typeof UPDATE_BLOCKERS)[number];

export const UPDATE_STATUSES = [
  "disabled",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "error"
] as const;

export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/**
 * What can go wrong, as codes.
 *
 * A release server's own error text is remote content, so it never reaches the
 * chrome; the wording lives in the component.
 */
export const UPDATE_ERRORS = [
  "network",
  "metadata-invalid",
  "signature-invalid",
  "download-failed",
  "install-failed"
] as const;

export type UpdateErrorCode = (typeof UPDATE_ERRORS)[number];

export type UpdateState =
  /** The only state a build that must not update can be in. */
  | { readonly status: "disabled"; readonly blockers: readonly UpdateBlocker[] }
  | { readonly status: "idle"; readonly currentVersion: string }
  | { readonly status: "checking" }
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "downloading"; readonly version: string; readonly percent: number }
  | { readonly status: "downloaded"; readonly version: string }
  | { readonly status: "error"; readonly code: UpdateErrorCode };

export interface UpdateEnvironment {
  /** `app.isPackaged`. A development build never updates itself. */
  readonly packaged: boolean;
  /** `RELEASE_READY`. False until signed artifacts and verified metadata exist. */
  readonly releaseReady: boolean;
  /** The channel's own switch, from `package.json`. */
  readonly channelEnabled: boolean;
}

/**
 * Every reason the channel is off, in the order a person would fix them.
 *
 * All of them, not the first: a maintainer turning on the channel should see
 * that signing is also outstanding, rather than discovering it one refusal at a
 * time.
 */
export function updateBlockers(environment: UpdateEnvironment): readonly UpdateBlocker[] {
  const blockers: UpdateBlocker[] = [];

  if (!environment.packaged) blockers.push("not-packaged");
  if (!environment.releaseReady) blockers.push("not-release-ready");
  if (!environment.channelEnabled) blockers.push("channel-disabled");

  return blockers;
}

/**
 * Whether the channel may operate at all.
 *
 * The conjunction is the safety property: three independent facts must agree,
 * so no single edit turns downloading-and-running-code on.
 */
export function isUpdateAllowed(environment: UpdateEnvironment): boolean {
  return updateBlockers(environment).length === 0;
}

/** The state a build starts in, which is `disabled` unless everything agrees. */
export function initialUpdateState(
  environment: UpdateEnvironment,
  currentVersion: string
): UpdateState {
  const blockers = updateBlockers(environment);
  if (blockers.length > 0) return { status: "disabled", blockers };
  return { status: "idle", currentVersion };
}

/**
 * Bounds a version string that came from release metadata.
 *
 * Remote, so it is treated as such: length-capped and restricted to the
 * characters a version can contain, because it is about to be displayed and
 * could otherwise carry anything.
 */
export function parseVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return null;
  if (!/^[A-Za-z0-9.+-]+$/u.test(trimmed)) return null;

  return trimmed;
}

/** Clamps a progress report, which also arrives from outside. */
export function parsePercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Whether a state permits starting a download.
 *
 * Asked of the state rather than tracked separately, so the button and the
 * handler cannot disagree about whether an update is ready to fetch.
 */
export function canDownload(state: UpdateState): boolean {
  return state.status === "available";
}

/** Whether a state permits restarting into an installed update. */
export function canInstall(state: UpdateState): boolean {
  return state.status === "downloaded";
}

/** Whether a state permits asking the server whether anything is new. */
export function canCheck(state: UpdateState): boolean {
  return state.status === "idle" || state.status === "error";
}

/* -------------------------------------------------------------------------- */
/* Payload validation                                                          */
/* -------------------------------------------------------------------------- */

export interface UpdateVersionPayload {
  readonly version: string;
}

export function parseUpdateVersionPayload(raw: unknown): UpdateVersionPayload {
  const root = requirePlainObject(raw, "Update request");
  const version = parseVersion(requireString(root["version"], "Version", MAX_VERSION_LENGTH));

  if (version === null) throw new Error("Version is not a version.");
  return { version };
}
