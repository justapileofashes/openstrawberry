/**
 * Extracting an article from a live guest page.
 *
 * The extraction script below runs *inside the page*, which is the only place
 * the rendered DOM exists. That means its output is page-controlled: a hostile
 * page can redefine every function the script calls and hand back whatever it
 * likes. Nothing here relies on the script behaving. Its result is JSON crossing
 * a boundary, and `buildReaderDocument` re-derives every field from scratch.
 *
 * What the script is allowed to return is deliberately narrow: a title, a
 * byline, a host, and a list of {kind, text} pairs. There is no field for
 * markup, a URL, an image, or a style, so the most a compromised extraction can
 * achieve is to put wrong *text* on the screen - which a page could do anyway by
 * simply containing that text.
 *
 * No network call is made, here or in the script. Reader mode in some browsers
 * means a round trip to a server that renders the article; here it means the
 * page you already loaded, with everything else taken away.
 */
import {
  buildReaderDocument,
  type ReaderDocument,
  type ReaderState
} from "../shared/reader.js";

/** The slice of a WebContents this module needs. */
export interface ReaderContentsPort {
  readonly executeJavaScript: (code: string) => Promise<unknown>;
  readonly getURL: () => string;
}

/**
 * The in-page extraction script.
 *
 * A heuristic, not a parser: find the densest block of prose on the page, then
 * walk it in document order collecting text. This is the same shape of approach
 * every reader view uses, because there is no markup convention that reliably
 * says "this is the article".
 *
 * Written as a self-contained expression with no dependency on anything outside
 * it, because it is evaluated in a context this process does not control and
 * cannot import into.
 */
const EXTRACT_SCRIPT = `(() => {
  try {
    const BLOCK_SELECTOR = "p, h1, h2, h3, h4, blockquote, li, pre";
    const SKIP = new Set(["NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "BUTTON", "SCRIPT", "STYLE", "NOSCRIPT", "SVG"]);

    const visible = (node) => {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number(style.opacity) === 0) return false;
      return true;
    };

    const buried = (node) => {
      let current = node.parentElement;
      let depth = 0;
      while (current !== null && depth < 40) {
        if (SKIP.has(current.tagName)) return true;
        if (current.getAttribute("aria-hidden") === "true") return true;
        const role = current.getAttribute("role");
        if (role === "navigation" || role === "banner" || role === "complementary") return true;
        current = current.parentElement;
        depth += 1;
      }
      return false;
    };

    /* Score candidate roots by how much paragraph text they contain. */
    const roots = Array.from(
      document.querySelectorAll("article, main, [role=main], .post, .article, .content, #content, body")
    );

    let best = document.body;
    let bestScore = -1;

    for (const root of roots) {
      let score = 0;
      for (const p of root.querySelectorAll("p")) {
        const length = (p.textContent || "").trim().length;
        /* Short paragraphs are captions, bylines, and cookie notices. */
        if (length > 60) score += length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = root;
      }
    }

    if (best === null || bestScore <= 0) return null;

    const kindFor = (tag) => {
      if (tag === "H1") return "heading";
      if (tag === "H2" || tag === "H3" || tag === "H4") return "subheading";
      if (tag === "BLOCKQUOTE") return "quote";
      if (tag === "LI") return "list-item";
      if (tag === "PRE") return "code";
      return "paragraph";
    };

    const blocks = [];
    const seen = new Set();

    for (const node of best.querySelectorAll(BLOCK_SELECTOR)) {
      if (blocks.length >= 2000) break;
      if (SKIP.has(node.tagName)) continue;
      if (!visible(node) || buried(node)) continue;

      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      if (text.length === 0) continue;

      /* A list item whose parent paragraph was already taken is a duplicate. */
      const key = node.tagName + ":" + text.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);

      blocks.push({ kind: kindFor(node.tagName), text: text.slice(0, 4000) });
    }

    const byline =
      document.querySelector("[rel=author]") ||
      document.querySelector("[itemprop=author]") ||
      document.querySelector(".byline") ||
      document.querySelector(".author");

    return {
      title: (document.title || "").trim(),
      byline: byline === null ? "" : (byline.textContent || "").trim(),
      site: window.location.hostname,
      blocks
    };
  } catch {
    /* A page that throws while being read is simply not an article. */
    return null;
  }
})()`;

/**
 * Reads the article out of a live page.
 *
 * Every failure - a page that throws, a script that returns nonsense, a
 * navigation mid-extraction, a page with no prose - becomes an `unavailable`
 * state with a code. None of them throws, because "this page has no reader
 * view" is an ordinary thing for a page to be, not an error the user caused.
 */
export async function extractReaderDocument(
  contents: ReaderContentsPort
): Promise<ReaderState> {
  let raw: unknown;

  try {
    raw = await contents.executeJavaScript(EXTRACT_SCRIPT);
  } catch {
    return { status: "unavailable", reason: "extraction-failed" };
  }

  if (raw === null || raw === undefined) {
    return { status: "unavailable", reason: "not-an-article" };
  }

  let host = "";
  try {
    host = new URL(contents.getURL()).hostname;
  } catch {
    host = "";
  }

  /*
   * Building is wrapped, not merely the script call.
   *
   * `executeJavaScript` serialises its result, so in practice a getter cannot
   * survive the crossing to throw while its fields are read. That is Electron's
   * behaviour, though, not this module's guarantee - and the guarantee stated
   * above is that no page produces an exception here. Depending on someone
   * else's serialisation to keep a promise this module made is the kind of
   * unstated assumption that stops being true quietly.
   */
  let document: ReaderDocument | null;
  try {
    document = buildReaderDocument(raw, host);
  } catch {
    return { status: "unavailable", reason: "extraction-failed" };
  }

  if (document === null) return { status: "unavailable", reason: "not-an-article" };

  return { status: "ready", document };
}
