/**
 * Media controls for HTML video and audio in a guest page.
 *
 * Two rules carry this feature, and the second is the one that matters most.
 *
 * **The page reports; it does not decide.** State is read out of a page that may
 * be hostile, so what comes back is bounded and re-derived here, exactly as
 * reader mode does. A page can lie about whether it is playing; the cost of that
 * is a wrong glyph, which is why nothing here is used for anything but display.
 *
 * **The renderer sends an action, never code.** `MEDIA_ACTIONS` is a closed set
 * of identifiers. The trusted process maps each one to a fixed script it holds.
 * There is no channel, field, or parameter on this contract through which a
 * renderer could supply JavaScript to run in a page, which is the difference
 * between a media control and a remote-execution primitive.
 *
 * Pure ASCII, so the closed sets stay reviewable.
 */

import { requireIdentifier, requireOneOf, requirePlainObject } from "./ipc-validation.js";

/** Bounds a media title read out of a page. */
export const MAX_MEDIA_TITLE_LENGTH = 200;

/**
 * Longest media this will describe: a shade over 24 hours.
 *
 * A live stream reports Infinity for duration, which is not a number to carry
 * into arithmetic, so anything past this is treated as "no known duration".
 */
export const MAX_MEDIA_DURATION_SECONDS = 90_000;

/**
 * What the chrome may ask a page to do.
 *
 * Deliberately small. Each is something a user could do by clicking the page's
 * own controls, so the chrome offering it grants no capability the page did not
 * already expose to them.
 */
export const MEDIA_ACTIONS = [
  "play",
  "pause",
  "mute",
  "unmute",
  "picture-in-picture"
] as const;

export type MediaAction = (typeof MEDIA_ACTIONS)[number];

export interface MediaState {
  /** False when the page has no media element worth controlling. */
  readonly hasMedia: boolean;
  readonly playing: boolean;
  readonly muted: boolean;
  /** Seconds, or 0 when the page reports no usable duration (a live stream). */
  readonly durationSeconds: number;
  readonly positionSeconds: number;
  /** Whether this element can enter picture-in-picture. Read, not assumed. */
  readonly canPictureInPicture: boolean;
  /** A label for the control, when the page offered one. */
  readonly title: string;
}

export function emptyMediaState(): MediaState {
  return {
    hasMedia: false,
    playing: false,
    muted: false,
    durationSeconds: 0,
    positionSeconds: 0,
    canPictureInPicture: false,
    title: ""
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a page's report                                                     */
/* -------------------------------------------------------------------------- */

/** Control characters and bidi overrides, which have no place in a label. */
const UNSAFE_DISPLAY = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "gu"
);

function mediaText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE_DISPLAY, "").replace(/\s+/gu, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

/**
 * Seconds, or 0 for anything that is not a usable number.
 *
 * A live stream reports Infinity and a stalled element reports NaN. Neither is a
 * duration, and both would render as nonsense if carried through, so both become
 * "unknown" - which the component draws as a control with no progress rather
 * than as a bar stuck at zero.
 */
function mediaSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, MAX_MEDIA_DURATION_SECONDS);
}

/**
 * Turns whatever a page returned into a state.
 *
 * The script runs inside the page and its output is page-controlled, so this
 * treats the input as hostile rather than as its own script's result. Anything
 * unreadable becomes "no media", which is the safe answer: the control simply
 * does not appear.
 */
export function buildMediaState(raw: unknown): MediaState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyMediaState();

  const report = raw as Record<string, unknown>;
  if (report["hasMedia"] !== true) return emptyMediaState();

  const duration = mediaSeconds(report["durationSeconds"]);

  return {
    hasMedia: true,
    playing: report["playing"] === true,
    muted: report["muted"] === true,
    durationSeconds: duration,
    // A position past the duration is a page contradicting itself; clamping
    // keeps the progress bar inside its track.
    positionSeconds: Math.min(mediaSeconds(report["positionSeconds"]), duration || Number.MAX_SAFE_INTEGER),
    canPictureInPicture: report["canPictureInPicture"] === true,
    title: mediaText(report["title"], MAX_MEDIA_TITLE_LENGTH)
  };
}

/** Completion as a fraction, or null when there is no duration to measure. */
export function mediaProgress(state: MediaState): number | null {
  if (!state.hasMedia || state.durationSeconds <= 0) return null;
  return Math.min(1, Math.max(0, state.positionSeconds / state.durationSeconds));
}

/** A compact clock, matching how a player shows elapsed time. */
export function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;

  const pad = (value: number): string => (value < 10 ? `0${value}` : `${value}`);

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface MediaTabPayload {
  readonly tabId: string;
}

export function parseMediaTabPayload(raw: unknown): MediaTabPayload {
  const root = requirePlainObject(raw, "Media request");
  return { tabId: requireIdentifier(root["tabId"], "Tab ID") };
}

export interface MediaCommandPayload {
  readonly tabId: string;
  readonly action: MediaAction;
}

/**
 * Validates a command.
 *
 * `requireOneOf` against the closed set is what keeps this a control surface
 * rather than an execution one: an action the app does not ship is refused here,
 * so nothing the renderer sends can reach a page as code.
 */
export function parseMediaCommandPayload(raw: unknown): MediaCommandPayload {
  const root = requirePlainObject(raw, "Media request");
  return {
    tabId: requireIdentifier(root["tabId"], "Tab ID"),
    action: requireOneOf(root["action"], MEDIA_ACTIONS, "Media action")
  };
}
