/**
 * Capturing what is on a live page, in the trusted process.
 *
 * The contract - what a node is, how it is re-derived, and how a capture is
 * worded and diffed - lives in `shared/page-snapshot.ts`. This file holds the
 * one thing that has to run inside a guest page, and it keeps the rule the
 * reader and media modules established: the script is a constant. It takes no
 * argument and is the same string on every call - the single value written into
 * it is a node cap fixed at module load, so there is no per-call input at all.
 * The question "could an agent get a string of its own evaluated in a page" has
 * the answer "there is nowhere to put one" rather than "it is escaped correctly".
 *
 * That rule is why the actions themselves are not here. Clicking, typing, and
 * pressing are dispatched as real input events against coordinates this capture
 * recorded - see `browser-input.ts` - so the agent's whole reach into a page is
 * this one constant plus a stream of mouse and key events. There is no second
 * script that takes a selector.
 *
 * Two limits worth knowing rather than discovering:
 *
 *   - **Shadow roots are not walked.** An element inside a closed shadow root is
 *     invisible to `querySelectorAll`, so a page built entirely from closed
 *     custom elements reports few nodes. That reads to an agent as a page with
 *     nothing to act on, which is the correct thing for it to be told.
 *   - **Cross-origin frames are not walked**, and same-origin ones are not
 *     either. A frame is a different document with its own coordinate space, and
 *     an input event dispatched at the top-level view lands where the frame is
 *     drawn, so the coordinates would still be right - but the ownership story
 *     would not be, and this is not the change to decide it in.
 */
import {
  buildPageSnapshot,
  MAX_SNAPSHOT_NODES,
  type PageSnapshot
} from "../shared/page-snapshot.js";

/** The slice of a WebContents this module needs. */
export interface SnapshotContentsPort {
  readonly executeJavaScript: (code: string) => Promise<unknown>;
  readonly getURL: () => string;
  readonly getTitle: () => string;
}

/**
 * The in-page walk.
 *
 * Self-contained, because it is evaluated in a context this process does not
 * control and cannot import into. Written defensively throughout: every property
 * read is wrapped, because a page can define a getter on anything and a throw
 * halfway through would return nothing rather than a partial page.
 *
 * The centre-point hit test is the part that earns its cost. An element can be
 * present, sized, and on screen while a cookie banner or modal is drawn over the
 * top of it, and clicking its coordinates then hits the banner. Asking the
 * document what is actually at that point is the difference between an agent
 * that dismisses the banner first and one that clicks nothing, twelve times.
 */
const SNAPSHOT_SCRIPT = `(() => {
  try {
    const LIMIT = ${String(MAX_SNAPSHOT_NODES)};
    const out = [];

    const attr = (element, name) => {
      try {
        const value = element.getAttribute(name);
        return typeof value === "string" ? value : "";
      } catch { return ""; }
    };

    const text = (node) => {
      try {
        const value = node.textContent;
        return typeof value === "string" ? value.replace(/\\s+/g, " ").trim().slice(0, 300) : "";
      } catch { return ""; }
    };

    const labelledBy = (element) => {
      const ids = attr(element, "aria-labelledby").split(/\\s+/).filter(Boolean).slice(0, 8);
      const parts = [];
      for (const id of ids) {
        try {
          const target = document.getElementById(id);
          if (target !== null) parts.push(text(target));
        } catch { /* a page may shadow getElementById */ }
      }
      return parts.join(" ").trim();
    };

    /* The conventional cascade, in the order a screen reader resolves it. */
    const nameOf = (element, tag) => {
      const referenced = labelledBy(element);
      if (referenced.length > 0) return referenced;

      const label = attr(element, "aria-label").trim();
      if (label.length > 0) return label;

      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        try {
          const labels = element.labels;
          if (labels && labels.length > 0) {
            const joined = Array.from(labels).map(text).join(" ").trim();
            if (joined.length > 0) return joined;
          }
        } catch { /* labels is a live list a page can break */ }

        const placeholder = attr(element, "placeholder").trim();
        if (placeholder.length > 0) return placeholder;
      }

      if (tag === "IMG") {
        const alt = attr(element, "alt").trim();
        if (alt.length > 0) return alt;
      }

      if (tag === "INPUT") {
        const type = attr(element, "type").toLowerCase();
        if (type === "submit" || type === "button" || type === "reset") {
          try {
            const value = element.value;
            if (typeof value === "string" && value.trim().length > 0) return value.trim();
          } catch { /* value may be a hostile getter */ }
        }
      }

      const own = text(element);
      if (own.length > 0) return own;

      const title = attr(element, "title").trim();
      if (title.length > 0) return title;

      return attr(element, "name").trim();
    };

    const explicitRole = (element) => attr(element, "role").toLowerCase();

    const roleOf = (element, tag) => {
      const declared = explicitRole(element);
      if (declared === "button" || declared === "link" || declared === "checkbox") return declared;
      if (declared === "radio" || declared === "tab" || declared === "menuitem") return declared;
      if (declared === "combobox" || declared === "slider" || declared === "option") return declared;
      if (declared === "heading") return "heading";
      if (declared === "alert" || declared === "status") return "alert";
      if (declared === "region" || declared === "main") return "region";
      if (declared === "textbox" || declared === "searchbox") return "textbox";

      if (tag === "A") return attr(element, "href").length > 0 ? "link" : null;
      if (tag === "BUTTON" || tag === "SUMMARY") return "button";
      if (tag === "SELECT") return "combobox";
      if (tag === "OPTION") return "option";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "IMG") return attr(element, "alt").length > 0 ? "image" : null;
      if (tag === "OUTPUT") return "alert";
      if (tag === "FORM" || tag === "MAIN" || tag === "NAV") return "region";
      if (tag === "H1" || tag === "H2" || tag === "H3") return "heading";

      if (tag === "INPUT") {
        const type = attr(element, "type").toLowerCase();
        if (type === "hidden") return null;
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
        if (type === "file") return "button";
        return "textbox";
      }

      if (attr(element, "contenteditable") === "true") return "textbox";
      if (element.tabIndex >= 0 && text(element).length > 0) return "button";
      return null;
    };

    /*
     * What consent this element will demand. Decided from the element, because
     * the act only ever says "click" and the element is the only thing that
     * knows whether that click submits, opens a file picker, or is ordinary.
     */
    const kindOf = (element, tag) => {
      if (tag === "INPUT") {
        const type = attr(element, "type").toLowerCase();
        if (type === "password") return "password";
        if (type === "file") return "file";
        if (type === "submit" || type === "image") return "submit";
        return "ordinary";
      }
      if (tag === "BUTTON") {
        const type = attr(element, "type").toLowerCase();
        /* A button inside a form with no type declared submits it. */
        if (type === "submit") return "submit";
        if (type === "") { try { return element.form ? "submit" : "ordinary"; } catch { return "ordinary"; } }
      }
      return "ordinary";
    };

    /*
     * Whether Enter here would send something. The form property is what the
     * platform itself uses to answer that, and it is null for anything outside
     * a form, which is exactly the question being asked.
     */
    const inFormOf = (element) => {
      try {
        if (element.form) return true;
      } catch { /* form is a property a page can shadow */ }
      try {
        return element.closest("form") !== null;
      } catch { return false; }
    };

    const disabledOf = (element) => {
      try { if (element.disabled === true) return true; } catch { /* getter */ }
      return attr(element, "aria-disabled") === "true";
    };

    const valueOf = (element, tag, kind) => {
      if (kind === "password") return null;
      try {
        if (tag === "SELECT") {
          const option = element.options ? element.options[element.selectedIndex] : null;
          return option ? text(option) : null;
        }
        if (tag === "INPUT" || tag === "TEXTAREA") {
          const type = attr(element, "type").toLowerCase();
          if (type === "checkbox" || type === "radio" || type === "file") return null;
          return typeof element.value === "string" ? element.value.slice(0, 200) : null;
        }
      } catch { /* value may be a hostile getter */ }
      return null;
    };

    const checkedOf = (element, tag) => {
      if (tag !== "INPUT") return null;
      const type = attr(element, "type").toLowerCase();
      if (type !== "checkbox" && type !== "radio") return null;
      try { return element.checked === true; } catch { return null; }
    };

    const hidden = (element) => {
      try {
        if (attr(element, "aria-hidden") === "true") return true;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return true;
        if (Number(style.opacity) === 0) return true;
      } catch { return true; }
      return false;
    };

    const SELECTOR = [
      "a[href]", "button", "input", "select", "textarea", "summary", "output",
      "img[alt]", "form", "main", "nav", "h1", "h2", "h3",
      "[role]", "[contenteditable=true]", "[tabindex]"
    ].join(",");

    let candidates;
    try { candidates = Array.from(document.querySelectorAll(SELECTOR)); }
    catch { candidates = []; }

    const seen = new Set();
    const viewportWidth = window.innerWidth || 0;
    const viewportHeight = window.innerHeight || 0;

    for (const element of candidates) {
      /* One past the limit is enough for the other side to report truncation. */
      if (out.length > LIMIT) break;
      if (seen.has(element)) continue;
      seen.add(element);

      let tag = "";
      try { tag = String(element.tagName || "").toUpperCase(); } catch { continue; }

      const role = roleOf(element, tag);
      if (role === null) continue;
      if (hidden(element)) continue;

      let rect;
      try { rect = element.getBoundingClientRect(); } catch { continue; }
      const width = rect.width || 0;
      const height = rect.height || 0;

      /* A heading or alert is worth reporting even at zero size; a control is not. */
      const positional = role !== "heading" && role !== "alert" && role !== "region";
      if (positional && (width <= 0 || height <= 0)) continue;

      const centreX = rect.left + width / 2;
      const centreY = rect.top + height / 2;

      let onScreen =
        width > 0 && height > 0 &&
        centreX >= 0 && centreY >= 0 &&
        centreX <= viewportWidth && centreY <= viewportHeight;

      /*
       * Present, sized, and on screen is not the same as clickable. Asking what
       * is actually painted at the centre is what catches an element behind a
       * cookie banner or a modal - the single most common reason a browser agent
       * clicks and nothing happens.
       */
      if (onScreen && positional) {
        try {
          const hit = document.elementFromPoint(centreX, centreY);
          onScreen =
            hit !== null &&
            (hit === element || element.contains(hit) || hit.contains(element));
        } catch { onScreen = false; }
      }

      const kind = kindOf(element, tag);

      out.push({
        role,
        name: nameOf(element, tag).slice(0, 200),
        value: valueOf(element, tag, kind),
        kind,
        checked: checkedOf(element, tag),
        disabled: disabledOf(element),
        inForm: inFormOf(element),
        optionIndex: (() => {
          try {
            if (tag === "OPTION") return typeof element.index === "number" ? element.index : null;
            /* For the control itself the index means "the one showing now". */
            if (tag === "SELECT") {
              return typeof element.selectedIndex === "number" ? element.selectedIndex : null;
            }
          } catch { /* both are properties a page can shadow */ }
          return null;
        })(),
        inViewport: onScreen,
        x: rect.left,
        y: rect.top,
        width,
        height
      });

      /*
       * A select's options are listed with it, so a choice can be named. They
       * are never clicked - the popup a native select opens is drawn by the
       * operating system and is not in this coordinate space - so the index is
       * what an arrow-key selection counts against.
       */
      if (tag === "SELECT") {
        let options = [];
        try { options = Array.from(element.options || []).slice(0, 60); } catch { options = []; }
        for (const option of options) {
          if (out.length > LIMIT) break;
          out.push({
            role: "option",
            name: text(option),
            value: null,
            kind: "ordinary",
            checked: null,
            disabled: disabledOf(option),
            inForm: inFormOf(element),
            optionIndex: typeof option.index === "number" ? option.index : null,
            inViewport: false,
            x: rect.left, y: rect.top, width: 0, height: 0
          });
        }
      }
    }

    return out;
  } catch {
    /* A page that throws while being walked simply has nothing to report. */
    return [];
  }
})()`;

/**
 * Captures one page.
 *
 * Never throws. A page that refused to run the script, navigated mid-capture, or
 * returned nonsense all come back as a snapshot with no nodes, which an agent
 * reads as "there is nothing here to act on" - true enough, and better than an
 * error it cannot do anything about.
 */
export async function capturePageSnapshot(
  contents: SnapshotContentsPort,
  generation: number
): Promise<PageSnapshot> {
  let raw: unknown;
  try {
    raw = await contents.executeJavaScript(SNAPSHOT_SCRIPT);
  } catch {
    raw = [];
  }

  /*
   * The address and the title are read from the browser rather than from the
   * page, because a page can set `document.title` to anything and this value
   * ends up in a transcript describing where the agent is.
   */
  let url = "";
  let title = "";
  try {
    url = contents.getURL();
    title = contents.getTitle();
  } catch {
    /* A destroyed view reports neither, and an empty string is the honest answer. */
  }

  return buildPageSnapshot(raw, { generation, url, title, capturedAt: Date.now() });
}
