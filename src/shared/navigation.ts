/**
 * Navigation policy and address-bar normalisation.
 *
 * OpenStrawberry allows HTTP(S) plus exactly one internal page, `about:blank`.
 * Every other scheme is rejected: `javascript:` would execute in the page's
 * origin, and `data:`/`blob:` are common phishing and bypass vectors.
 *
 * This module is pure so the same decision can be enforced in three places: the
 * address bar, the guest view's `will-navigate` guard, and session restore.
 *
 * `file:` is the one scheme with two answers, and they are kept in two
 * functions. `isAllowedUrl` still says no - typing a path into the address bar
 * is refused, a web page cannot navigate a tab to the local disk, and a
 * restored session will not resurrect one. `isLocalDocumentUrl` says yes to a
 * narrow shape: an HTML document, on this machine, that the desktop asked us to
 * open. The app is registered with Windows as a handler for exactly those file
 * types, and a registration the app refuses to honour is worse than no
 * registration at all - so the capability exists, and it stops at the edge of
 * what was claimed.
 */

import { BLANK_PAGE } from "./desktop-shell.js";

export const ALLOWED_SCHEMES = ["http:", "https:"] as const;

/**
 * Where non-URL address input goes. This is a real network request to a third
 * party, so it happens only on explicit user input, never implicitly.
 */
export const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

/**
 * Search engines OpenStrawberry knows how to reach, by display name.
 *
 * This table is the whole reason migration can honour a user's search engine
 * without ever reading one.
 *
 * Chromium's preferences file holds the search URL template, the suggestion
 * endpoint, the keyword, and sync metadata. `parseChromiumSearchName` returns
 * only the display name, and `MIGRATION_PRIVACY.md` says so. That leaves a
 * question: how do you honour "this user searches with DuckDuckGo" without
 * copying the thing that says how?
 *
 * You ship the answer. A name is matched against this table and resolved to a
 * template OpenStrawberry wrote. An imported string is never navigated to, never
 * interpolated into a URL, and never stored as one - it only ever selects from
 * addresses already in this file. A name that matches nothing falls back to the
 * default, which is the correct outcome for an engine this browser has no
 * template for.
 */
const SEARCH_TEMPLATES: readonly (readonly [string, string])[] = [
  ["google", "https://www.google.com/search?q=%s"],
  ["duckduckgo", "https://duckduckgo.com/?q=%s"],
  ["ddg", "https://duckduckgo.com/?q=%s"],
  ["bing", "https://www.bing.com/search?q=%s"],
  ["brave", "https://search.brave.com/search?q=%s"],
  ["bravesearch", "https://search.brave.com/search?q=%s"],
  ["startpage", "https://www.startpage.com/sp/search?query=%s"],
  ["ecosia", "https://www.ecosia.org/search?q=%s"],
  ["qwant", "https://www.qwant.com/?q=%s"],
  ["mojeek", "https://www.mojeek.com/search?q=%s"],
  ["kagi", "https://kagi.com/search?q=%s"],
  ["yahoo", "https://search.yahoo.com/search?p=%s"],
  ["perplexity", "https://www.perplexity.ai/search?q=%s"],
  ["wikipedia", "https://en.wikipedia.org/w/index.php?search=%s"]
];

/** Reduces a display name to the form the table is keyed by. */
function searchKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/**
 * The template for an imported search engine name, or null when unrecognised.
 *
 * Null rather than a guess: an engine this browser cannot spell a URL for is one
 * the caller should fall back on the default for, and inventing a pattern from
 * the name would be exactly the "copy the template" behaviour migration refuses.
 */
export function searchTemplateForName(name: string | null | undefined): string | null {
  if (typeof name !== "string" || name.length === 0) return null;

  const key = searchKey(name);
  if (key.length === 0) return null;

  for (const [candidate, template] of SEARCH_TEMPLATES) {
    if (key === candidate) return template;
  }

  // A name like "Google (default)" or "DuckDuckGo Lite" still names the engine.
  for (const [candidate, template] of SEARCH_TEMPLATES) {
    if (key.startsWith(candidate)) return template;
  }

  return null;
}

/** The template to search with, given whatever migration recorded. */
export function resolveSearchTemplate(name: string | null | undefined): string {
  return searchTemplateForName(name) ?? DEFAULT_SEARCH_TEMPLATE;
}

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
 * The file extensions this browser will open when the operating system asks.
 *
 * This list is a promise. Windows offers OpenStrawberry as a candidate for
 * exactly these types, and `resources/installer.nsh` registers exactly these -
 * `pnpm verify:config` fails the release if the two lists drift apart. Adding an
 * extension here without teaching the app to render it would put a claim in the
 * registry the app cannot honour, which is the whole failure this list exists to
 * prevent.
 */
export const LOCAL_DOCUMENT_EXTENSIONS = [".htm", ".html", ".shtml", ".xht", ".xhtml"] as const;

/**
 * Whether a URL names a local document this app may open *on the OS's request*.
 *
 * Deliberately not part of `isAllowedUrl`, and the separation is the point.
 * `isAllowedUrl` answers "may this be navigated to", and its answer for `file:`
 * stays no: the address bar refuses it, a web page cannot reach it, and session
 * restore will not resurrect it. This answers a narrower question - "did the
 * desktop hand us a document to render" - and only two callers ask it.
 *
 * The extension check is what keeps the widening honest. `file:///C:/` or a
 * private key would be refused here even though both are perfectly good `file:`
 * URLs, because the registration claims HTML documents and nothing else.
 */
export function isLocalDocumentUrl(value: string): boolean {
  const url = parseUrl(value);
  if (url === null) return false;
  if (url.protocol !== "file:") return false;

  // A `file:` URL carrying a host is a UNC path pointing at another machine.
  // That is a network fetch wearing a local scheme, and it is not what the OS
  // hands over when someone double-clicks a document.
  if (url.hostname !== "") return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    // A malformed percent-escape. Undecodable is unopenable.
    return false;
  }

  if (pathname.includes("\0")) return false;

  return LOCAL_DOCUMENT_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

/**
 * Detects a real scheme prefix.
 *
 * The colon must not be followed by a digit, otherwise `localhost:5173` would
 * be read as the scheme `localhost:` and refused instead of navigated.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:(?!\d)/iu;

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/iu;

/** `C:\page.html` or `C:/page.html` - a drive letter, not a URL scheme. */
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/iu;

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

/**
 * Picks out an argument that names a local document, without touching the disk.
 *
 * Only the shape of the argument is judged here, so this stays pure and the
 * renderer can bundle the module. Whether the path exists, and what it resolves
 * to, is decided by `src/main/launch-target.ts` - which is the only place that
 * may ask, because that answer is different on every machine.
 *
 * A `file:` URL is refused rather than passed through. Windows hands over a
 * plain path; anything already wearing a scheme came from somewhere else, and
 * `urlFromCommandLine` above has already had its say on those.
 */
export function localDocumentArgument(argv: readonly string[]): string | null {
  for (const argument of argv) {
    if (argument.startsWith("-")) continue;
    if (argument.includes("\0")) continue;

    // `C:\page.html` matches SCHEME_PATTERN, because a drive letter and a
    // one-character scheme are the same thing to a parser. The drive path is
    // recognised first, or Windows would hand this function the one argument
    // shape it exists to read and be told it was a URL.
    if (!WINDOWS_DRIVE_PATH.test(argument) && SCHEME_PATTERN.test(argument)) continue;

    const lowered = argument.toLowerCase();
    if (LOCAL_DOCUMENT_EXTENSIONS.some((extension) => lowered.endsWith(extension))) return argument;
  }
  return null;
}

/** A short, safe label for a tab whose page has not reported a title yet. */
export function displayHostname(value: string): string {
  if (value === BLANK_PAGE) return "New tab";
  const url = parseUrl(value);
  if (url === null) return "New tab";

  // A local document has no hostname to show, and "New tab" would be a worse
  // label than the filename the person just double-clicked.
  if (url.protocol === "file:") {
    try {
      const segments = decodeURIComponent(url.pathname).split("/");
      const name = segments[segments.length - 1] ?? "";
      return name === "" ? "New tab" : name;
    } catch {
      return "New tab";
    }
  }

  return url.hostname === "" ? "New tab" : url.hostname.replace(/^www\./u, "");
}
