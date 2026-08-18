/**
 * Tracker blocking policy.
 *
 * This is deliberately not an ad blocker, and `docs/SECURITY.md` says so. It is
 * a short, reviewable list of hosts whose only purpose is to watch people, with
 * rules chosen so that a mistake fails toward the page working:
 *
 *   1. **The list is fixed and shipped.** No subscription, no remote update, no
 *      filter-list fetch. A blocker that phones home for its rules is itself a
 *      network call to a third party on every launch, which is the thing this
 *      feature exists to reduce.
 *   2. **First-party requests are never blocked.** A site loading its own
 *      analytics subdomain is left alone. This gives up some coverage on
 *      purpose: CNAME-cloaked tracking is real, and catching it means blocking
 *      requests a site makes to itself, which breaks pages in ways users cannot
 *      diagnose.
 *   3. **Exceptions are per-site and permanent until removed.** A page that
 *      breaks is a page the user can fix themselves, immediately, without
 *      turning the feature off everywhere.
 *   4. **Counts are the whole interface.** The user is told what was blocked on
 *      the page in front of them. A blocker that cannot be inspected asks for
 *      more trust than it has earned.
 *
 * This file is pure ASCII so the host list stays reviewable: a homoglyph in a
 * domain name is precisely the sort of thing that must not hide here.
 */

import {
  IpcValidationError,
  requireBoolean,
  requireIdentifier,
  requirePlainObject,
  requireString
} from "./ipc-validation.js";

/** Bounds a stored exception list. Far past what anyone curates by hand. */
export const MAX_EXCEPTIONS = 500;

/** Bounds a hostname, which is also what DNS permits. */
export const MAX_HOST_LENGTH = 253;

/**
 * Hosts whose sole purpose is measurement, profiling, or ad targeting.
 *
 * Each entry is a registrable domain and matches itself and its subdomains.
 * The bar for inclusion is that blocking it does not remove page content a user
 * asked for. Error reporting, payment processors, CDNs, fonts, captchas, and
 * consent managers are all deliberately absent: they change what a page can do,
 * not merely who is watching it.
 */
export const TRACKER_HOSTS: readonly string[] = [
  // Analytics
  "google-analytics.com",
  "googletagmanager.com",
  "analytics.google.com",
  "scorecardresearch.com",
  "quantserve.com",
  "chartbeat.com",
  "parsely.com",
  "mixpanel.com",
  "amplitude.com",
  "segment.com",
  "segment.io",
  "heap.io",
  "statcounter.com",
  "matomo.cloud",
  // Session recording and behaviour profiling
  "hotjar.com",
  "hotjar.io",
  "fullstory.com",
  "mouseflow.com",
  "luckyorange.com",
  "inspectlet.com",
  "clarity.ms",
  "smartlook.com",
  // Advertising and cross-site identity
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "adsrvr.org",
  "criteo.com",
  "criteo.net",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "taboola.com",
  "outbrain.com",
  "sharethrough.com",
  "bidswitch.net",
  // Social widgets used primarily as beacons
  "connect.facebook.net",
  "facebook.net",
  "ads-twitter.com",
  "analytics.tiktok.com",
  // Mobile and campaign attribution
  "branch.io",
  "appsflyer.com",
  "adjust.com",
  "kochava.com",
  "singular.net"
];

/**
 * Multi-label public suffixes this policy needs to know about.
 *
 * Not a full Public Suffix List, and not trying to be: the only question asked
 * of it is "are these two hosts the same site", and the consequence of getting
 * it wrong is that a request is *not* blocked. Erring toward leaving a request
 * alone is the correct direction for a conservative blocker, so a short list
 * covering the common cases is the right amount of machinery.
 */
const MULTI_LABEL_SUFFIXES: readonly string[] = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "net.nz", "org.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr",
  "com.br", "net.br", "org.br",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.in", "net.in", "org.in",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw",
  "co.za", "com.es", "com.pl", "co.il"
];

export function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_HOST_LENGTH) return "";
  // A trailing dot is a legal fully-qualified name and must not read as a
  // different host from the same name without it.
  return trimmed.replace(/\.+$/u, "");
}

/** The hostname of a URL, or "" when it has none. */
export function hostOf(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

/**
 * The registrable domain: the label below the public suffix, plus the suffix.
 *
 * `a.b.example.co.uk` reduces to `example.co.uk`. An address that is already a
 * bare suffix, or an IP literal, is returned unchanged, because there is no
 * narrower thing to reduce it to.
 */
export function registrableDomain(host: string): string {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) return "";

  // An IPv4 or IPv6 literal is its own site; splitting it on dots is meaningless.
  if (/^[\d.]+$/u.test(normalized) || normalized.includes(":")) return normalized;

  const labels = normalized.split(".");
  if (labels.length <= 2) return normalized;

  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.includes(lastTwo)) {
    return labels.slice(-3).join(".");
  }

  return lastTwo;
}

/** True when `host` is `domain` or a subdomain of it. */
export function isHostWithin(host: string, domain: string): boolean {
  if (host.length === 0 || domain.length === 0) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/** True when the host is, or sits under, a listed tracker domain. */
export function isTrackerHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized.length === 0) return false;
  return TRACKER_HOSTS.some((domain) => isHostWithin(normalized, domain));
}

/** True when two addresses belong to the same site. */
export function isSameSite(requestHost: string, pageHost: string): boolean {
  const request = registrableDomain(requestHost);
  const page = registrableDomain(pageHost);
  return request.length > 0 && request === page;
}

/**
 * Why a request was or was not blocked.
 *
 * A reason rather than a boolean, because the panel explains itself and because
 * a test asserting *why* something was allowed catches a rule that produces the
 * right answer accidentally.
 */
export type BlockDecision =
  | { readonly blocked: true; readonly reason: "tracker" }
  | {
      readonly blocked: false;
      readonly reason: "disabled" | "site-exception" | "first-party" | "not-a-tracker";
    };

export interface BlockContext {
  readonly enabled: boolean;
  /** Registrable domains the user has excepted. */
  readonly exceptions: ReadonlySet<string>;
}

/**
 * The single decision, applied to every request the session sees.
 *
 * The order of the checks is the policy. Disabled beats everything; a user's own
 * exception beats the list; first-party beats the list; and only then does being
 * a known tracker matter. Each earlier rule is a reason to leave a request
 * alone, so a request survives unless every one of them declines to save it.
 */
export function decideRequest(
  requestUrl: string,
  pageUrl: string,
  context: BlockContext
): BlockDecision {
  if (!context.enabled) return { blocked: false, reason: "disabled" };

  const pageHost = hostOf(pageUrl);
  const site = registrableDomain(pageHost);
  if (site.length > 0 && context.exceptions.has(site)) {
    return { blocked: false, reason: "site-exception" };
  }

  const requestHost = hostOf(requestUrl);
  if (requestHost.length === 0) return { blocked: false, reason: "not-a-tracker" };

  // A site talking to itself is never blocked, even when the name is listed.
  if (pageHost.length > 0 && isSameSite(requestHost, pageHost)) {
    return { blocked: false, reason: "first-party" };
  }

  return isTrackerHost(requestHost)
    ? { blocked: true, reason: "tracker" }
    : { blocked: false, reason: "not-a-tracker" };
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                    */
/* -------------------------------------------------------------------------- */

/** What the chrome renders. Counts and site names; never a blocked URL. */
export interface TrackingSnapshot {
  readonly enabled: boolean;
  /** The focused tab's registrable domain, or "" when there is none. */
  readonly site: string;
  /** How many requests were blocked on the focused tab's current page. */
  readonly blockedOnPage: number;
  /** Whether the focused site is excepted. */
  readonly siteExcepted: boolean;
  /** Every excepted site, so Settings can list and revoke them. */
  readonly exceptions: readonly string[];
}

export function emptyTrackingSnapshot(): TrackingSnapshot {
  return { enabled: true, site: "", blockedOnPage: 0, siteExcepted: false, exceptions: [] };
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface TrackingSitePayload {
  readonly tabId: string;
}

export function parseTrackingSitePayload(raw: unknown): TrackingSitePayload {
  const root = requirePlainObject(raw, "Tracking request");
  return { tabId: requireIdentifier(root["tabId"], "Tab ID") };
}

export interface TrackingEnabledPayload {
  readonly enabled: boolean;
}

export function parseTrackingEnabledPayload(raw: unknown): TrackingEnabledPayload {
  const root = requirePlainObject(raw, "Tracking request");
  return { enabled: requireBoolean(root["enabled"], "Enabled") };
}

export interface TrackingExceptionPayload {
  readonly site: string;
}

export function parseTrackingExceptionPayload(raw: unknown): TrackingExceptionPayload {
  const root = requirePlainObject(raw, "Tracking request");
  return { site: parseExceptionSite(root["site"], "Site") };
}

/**
 * A site name the renderer sent, reduced to a registrable domain.
 *
 * The renderer names a site to except rather than sending a URL, and it is
 * re-reduced here: what gets stored is a domain this module derived, not a
 * string the renderer chose the shape of.
 */
export function parseExceptionSite(raw: unknown, field: string): string {
  const text = requireString(raw, field, MAX_HOST_LENGTH);
  const site = registrableDomain(text);
  // An IpcValidationError so the router passes the message through; it names the
  // field and never the rejected value.
  if (site.length === 0) throw new IpcValidationError(`${field} must name a site.`);
  return site;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export const TRACKING_STATE_VERSION = 1;

export interface PersistedTrackingState {
  readonly version: number;
  readonly enabled: boolean;
  readonly exceptions: readonly string[];
}

export function emptyTrackingState(): PersistedTrackingState {
  // On by default. A privacy feature nobody finds is not a privacy feature.
  return { version: TRACKING_STATE_VERSION, enabled: true, exceptions: [] };
}

export function parseTrackingState(raw: unknown): PersistedTrackingState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyTrackingState();

  const root = raw as Record<string, unknown>;
  if (root["version"] !== TRACKING_STATE_VERSION) return emptyTrackingState();

  const enabled = typeof root["enabled"] === "boolean" ? root["enabled"] : true;

  const rawExceptions = Array.isArray(root["exceptions"]) ? root["exceptions"] : [];
  const exceptions: string[] = [];
  const seen = new Set<string>();

  for (const entry of rawExceptions.slice(0, MAX_EXCEPTIONS)) {
    if (typeof entry !== "string") continue;
    // Re-reduced on read: a hand-edited file cannot introduce an entry that
    // would match more broadly than a registrable domain.
    const site = registrableDomain(entry);
    if (site.length === 0 || seen.has(site)) continue;
    seen.add(site);
    exceptions.push(site);
  }

  return { version: TRACKING_STATE_VERSION, enabled, exceptions };
}
