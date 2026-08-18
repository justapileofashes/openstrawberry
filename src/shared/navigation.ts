/**
 * Navigation policy and address-bar normalisation.
 *
 * OpenStrawberry allows HTTP(S) plus exactly one internal page, `about:blank`.
 * Every other scheme is rejected — `file:` would expose the local disk,
 * `javascript:` would execute in the page's origin, and `data:`/`blob:` are
 * common phishing and bypass vectors.
 *
 * This module is pure so the same decision can be enforced in three places: the
 * address bar, the guest view's `will-navigate` guard, and session restore.
 */

import { BLANK_PAGE } from "./desktop-shell.js";

export const ALLOWED_SCHEMES = ["http:", "https:"] as const;

/**
 * Where non-URL address input goes. This is a real network request to a third
 * party, so it happens only on explicit user input, never implicitly.
 */
export const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

/** Bounds address input before it reaches the URL parser. */
export const MAX_ADDRESS_LENGTH = 4096;

export type NavigationDecision =
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "rejected"; readonly reason: string };

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The single authority on whether a fully-formed URL may be loaded.
 *
 * `about:blank` is compared exactly: `about:blank#x` and `about:srcdoc` are not
 * the neutral internal page and are refused.
 */
export function isAllowedUrl(value: string): boolean {
  if (value === BLANK_PAGE) return true;

  const url = parseUrl(value);
  if (url === null) return false;
  if (!(ALLOWED_SCHEMES as readonly string[]).includes(url.protocol)) return false;

  // Credentials embedded in a URL are a phishing staple and would otherwise be
  // carried into history and session restore.
  if (url.username !== "" || url.password !== "") return false;

  // http://  with no host is not navigable.
  return url.hostname !== "";
}

/**
 * Detects a real scheme prefix.
 *
 * The colon must not be followed by a digit, otherwise `localhost:5173` would
 * be read as the scheme `localhost:` and refused instead of navigated.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:(?!\d)/iu;

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/iu;

function isIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function looksLikeHostname(value: string): boolean {
  if (/\s/u.test(value)) return false;

  const [hostPart = ""] = value.split("/");
  const host = hostPart.split(":")[0] ?? "";

  if (host === "localhost") return true;
  if (isIPv4(host)) return true;

  // A bare label with no dot is a search term, not a host.
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL_PATTERN.test(label))) return false;

  // A numeric final label means this is something like "3.5" — a version or a
  // number the user is searching for, not a domain.
  const tld = labels[labels.length - 1] ?? "";
  return /^[a-z]{2,}$/iu.test(tld);
}

function isLoopbackHost(value: string): boolean {
  const [hostPart = ""] = value.split("/");
  const host = hostPart.split(":")[0] ?? "";
  return host === "localhost" || host === "127.0.0.1";
}

export function buildSearchUrl(
  query: string,
  template: string = DEFAULT_SEARCH_TEMPLATE
): string {
  return template.replace("%s", encodeURIComponent(query));
}

/**
 * Turns raw address-bar input into a navigation decision.
 *
 * Typed input that already names a scheme is honoured or refused on its merits;
 * a user typing `https://example.com` must still navigate normally. Bare hosts
 * gain a scheme, and anything else becomes a search.
 */
export function normalizeAddressInput(
  input: string,
  searchTemplate: string = DEFAULT_SEARCH_TEMPLATE
): NavigationDecision {
  const trimmed = input.trim();

  if (trimmed.length === 0) return { kind: "rejected", reason: "Address is empty." };
  if (trimmed.length > MAX_ADDRESS_LENGTH) {
    return { kind: "rejected", reason: "Address is too long." };
  }

  if (trimmed === BLANK_PAGE) return { kind: "navigate", url: BLANK_PAGE };

  // Anything carrying an explicit scheme is judged as a URL, never rewritten
  // into a search. That keeps `javascript:` and `file:` refusals visible to the
  // user instead of silently searching for them.
  if (SCHEME_PATTERN.test(trimmed)) {
    if (isAllowedUrl(trimmed)) {
      const url = parseUrl(trimmed);
      return url === null
        ? { kind: "rejected", reason: "Address could not be parsed." }
        : { kind: "navigate", url: url.href };
    }
    return { kind: "rejected", reason: "That address scheme is not allowed." };
  }

  if (looksLikeHostname(trimmed)) {
    const scheme = isLoopbackHost(trimmed) ? "http://" : "https://";
    const candidate = `${scheme}${trimmed}`;
    if (isAllowedUrl(candidate)) {
      const url = parseUrl(candidate);
      if (url !== null) return { kind: "navigate", url: url.href };
    }
  }

  return { kind: "navigate", url: buildSearchUrl(trimmed, searchTemplate) };
}

/**
 * Favicons are decorative and come from arbitrary sites, so they are accepted
 * only over HTTPS. Anything else falls back to the neutral globe glyph.
 */
export function isSafeFaviconUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  const url = parseUrl(value);
  return url !== null && url.protocol === "https:" && url.hostname !== "";
}

/**
 * Extracts a navigable URL from process arguments.
 *
 * The desktop shell launches the app with a URL appended when the user opens a
 * link, and Windows re-launches it that way for an already-running instance.
 * Arguments are attacker-adjacent — anything can invoke the binary — so a
 * candidate must satisfy the same navigation policy as typed input, and
 * switches are never treated as URLs.
 */
export function urlFromCommandLine(argv: readonly string[]): string | null {
  // The first argument is the executable, and in development the second is the
  // app directory. Neither is ever a URL, and both are skipped by the checks
  // below rather than by index.
  for (const argument of argv) {
    if (argument.startsWith("-")) continue;
    if (!/^https?:\/\//iu.test(argument)) continue;
    if (isAllowedUrl(argument)) return argument;
  }
  return null;
}

/** A short, safe label for a tab whose page has not reported a title yet. */
export function displayHostname(value: string): string {
  if (value === BLANK_PAGE) return "New tab";
  const url = parseUrl(value);
  if (url === null) return "New tab";
  return url.hostname === "" ? "New tab" : url.hostname.replace(/^www\./u, "");
}
