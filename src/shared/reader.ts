/**
 * Reader mode: a page's text, and nothing else.
 *
 * The security shape of this feature is unusual and worth stating plainly.
 * Everywhere else in OpenStrawberry, hostile page content stays inside a guest
 * view that the trusted renderer never touches. Reader mode deliberately carries
 * page content *across* that boundary and displays it in the chrome. So the
 * content is reduced to the least dangerous thing that is still useful:
 *
 *   1. **Text, never markup.** A block carries a string. There is no field for
 *      HTML, a URL, an image, a style, or an attribute, so there is nothing for
 *      the renderer to interpret. The renderer puts these strings in React text
 *      nodes, which escape by construction - `dangerouslySetInnerHTML` must
 *      never appear anywhere near this feature.
 *   2. **No network, no provider.** Extraction reads the DOM the guest already
 *      loaded. Nothing is fetched, nothing is summarised, nothing is sent
 *      anywhere. "Reader mode" in some browsers means a round trip to a server;
 *      here it means the opposite.
 *   3. **Bounded before it is trusted.** Every string is length-capped and every
 *      collection is count-capped, applied on the way in rather than at display,
 *      so a hostile page cannot force a large allocation in the trusted process.
 *   4. **Invisible characters are stripped.** Control characters and
 *      bidirectional overrides are removed, because text that renders as
 *      something other than what it says is exactly the problem a reader view
 *      is supposed to solve.
 *
 * This file is pure ASCII so the character classes doing that stripping stay
 * reviewable.
 */

import { requireIdentifier, requirePlainObject } from "./ipc-validation.js";

/** Bounds one block. Generous for a long paragraph, far short of a whole page. */
export const MAX_BLOCK_LENGTH = 4000;

/** Bounds how many blocks a document holds. A long article is a few hundred. */
export const MAX_BLOCKS = 2000;

export const MAX_TITLE_LENGTH = 300;
export const MAX_BYLINE_LENGTH = 200;
export const MAX_SITE_LENGTH = 253;

/**
 * Bounds the whole document.
 *
 * The per-block caps multiplied together would still permit several megabytes,
 * which is more than any article and enough to make the chrome stutter. This is
 * the backstop that makes the total bounded rather than merely each part.
 */
export const MAX_DOCUMENT_CHARS = 400_000;

/**
 * The kinds of block a reader view renders.
 *
 * A closed set, because each one maps to a fixed element in the component. A
 * page cannot introduce a kind, so it cannot reach markup the component does not
 * already contain.
 */
export const READER_BLOCK_KINDS = ["heading", "subheading", "paragraph", "quote", "list-item", "code"] as const;

export type ReaderBlockKind = (typeof READER_BLOCK_KINDS)[number];

export interface ReaderBlock {
  readonly kind: ReaderBlockKind;
  /** Plain text. Never markup, never a URL. */
  readonly text: string;
}

export interface ReaderDocument {
  readonly title: string;
  /** Author or dateline, when the page declared one. Empty otherwise. */
  readonly byline: string;
  /** The host, for provenance. The chrome shows what it is reading. */
  readonly site: string;
  readonly blocks: readonly ReaderBlock[];
  /** Whole-document word count, so the view can estimate reading time. */
  readonly wordCount: number;
  /** True when bounds cut the article short, so the view can say so. */
  readonly truncated: boolean;
}

export type ReaderState =
  | { readonly status: "closed" }
  | { readonly status: "unavailable"; readonly reason: ReaderUnavailableReason }
  | { readonly status: "ready"; readonly document: ReaderDocument };

/**
 * Why a page has no reader view.
 *
 * Codes rather than messages, so nothing from the page can reach the chrome as
 * free text, and so the wording lives in one place in the component.
 */
export const READER_UNAVAILABLE_REASONS = [
  "no-page",
  "not-an-article",
  "extraction-failed"
] as const;

export type ReaderUnavailableReason = (typeof READER_UNAVAILABLE_REASONS)[number];

export function closedReaderState(): ReaderState {
  return { status: "closed" };
}

/* -------------------------------------------------------------------------- */
/* Text reduction                                                              */
/* -------------------------------------------------------------------------- */

/** C0 controls, DEL, C1 controls. Tab and newline are handled as whitespace. */
const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]", "gu");

/**
 * Bidirectional overrides and isolates.
 *
 * A reader view exists so a person can read text without the page's own
 * presentation getting in the way. Text that renders in a different order than
 * it is stored is that problem in its purest form, so these are removed rather
 * than rendered.
 */
const BIDI_OVERRIDES = new RegExp("[\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]", "gu");

/** Zero-width characters, which pad text invisibly and defeat length bounds. */
const ZERO_WIDTH = new RegExp("[\\u200B\\u200C\\u200D\\uFEFF]", "gu");

/**
 * Reduces page text to something safe to store and display.
 *
 * Whitespace is collapsed because the DOM's own formatting - indentation,
 * line wrapping in the source - is not the article's formatting, and carrying it
 * through would make every paragraph ragged.
 */
export function readerText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";

  const cleaned = value
    .replace(CONTROL_CHARACTERS, "")
    .replace(BIDI_OVERRIDES, "")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/gu, " ")
    .trim();

  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trimEnd()}...` : cleaned;
}

/** Words, for the reading-time estimate. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/u).length;
}

/** Minutes at an unhurried adult reading pace, floored at one. */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 220));
}

/* -------------------------------------------------------------------------- */
/* Building a document from extracted blocks                                   */
/* -------------------------------------------------------------------------- */

function parseKind(value: unknown): ReaderBlockKind | null {
  if (typeof value !== "string") return null;
  return (READER_BLOCK_KINDS as readonly string[]).includes(value)
    ? (value as ReaderBlockKind)
    : null;
}

/**
 * Turns whatever the extraction script returned into a document.
 *
 * The script runs inside the guest page, which means its output is page-
 * controlled: a hostile page can replace the functions it uses and return
 * anything at all. So this treats the input as hostile rather than as its own
 * script's output, and every field is re-derived here.
 *
 * Returns null when nothing usable came back, which the caller reports as
 * "not an article" rather than as an error.
 */
export function buildReaderDocument(raw: unknown, fallbackSite: string): ReaderDocument | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;

  const rawBlocks = Array.isArray(root["blocks"]) ? root["blocks"] : [];

  const blocks: ReaderBlock[] = [];
  let characters = 0;
  let truncated = false;

  for (const entry of rawBlocks) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;

    const block = entry as Record<string, unknown>;
    const kind = parseKind(block["kind"]);
    if (kind === null) continue;

    const text = readerText(block["text"], MAX_BLOCK_LENGTH);
    if (text.length === 0) continue;

    if (characters + text.length > MAX_DOCUMENT_CHARS) {
      truncated = true;
      break;
    }

    characters += text.length;
    blocks.push({ kind, text });
  }

  // A page with a heading and nothing under it is a navigation page, not an
  // article. Reporting it as unavailable is more honest than showing a title
  // over emptiness.
  const hasProse = blocks.some(
    (block) => block.kind === "paragraph" || block.kind === "quote" || block.kind === "list-item"
  );
  if (!hasProse) return null;

  const wordCount = blocks.reduce((total, block) => total + countWords(block.text), 0);

  return {
    title: readerText(root["title"], MAX_TITLE_LENGTH),
    byline: readerText(root["byline"], MAX_BYLINE_LENGTH),
    site: readerText(root["site"], MAX_SITE_LENGTH) || fallbackSite,
    blocks,
    wordCount,
    truncated
  };
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface ReaderTabPayload {
  readonly tabId: string;
}

export function parseReaderTabPayload(raw: unknown): ReaderTabPayload {
  const root = requirePlainObject(raw, "Reader request");
  return { tabId: requireIdentifier(root["tabId"], "Tab ID") };
}
