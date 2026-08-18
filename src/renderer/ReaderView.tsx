import { useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  readingMinutes,
  type ReaderBlock,
  type ReaderDocument,
  type ReaderState,
  type ReaderUnavailableReason
} from "../shared/reader.js";

/**
 * One block.
 *
 * Every branch puts `block.text` in a React text node, which escapes by
 * construction. `dangerouslySetInnerHTML` must never appear in this file: the
 * text came from a page that may be hostile, and the whole reason the shared
 * contract carries strings rather than markup is so this component has nothing
 * dangerous available to it.
 *
 * The switch is exhaustive over a closed set of kinds, so a page cannot reach an
 * element the component does not already contain.
 */
function Block({ block }: { readonly block: ReaderBlock }): React.JSX.Element {
  switch (block.kind) {
    case "heading":
      return <h1 className="rd-h1">{block.text}</h1>;
    case "subheading":
      return <h2 className="rd-h2">{block.text}</h2>;
    case "quote":
      return <blockquote className="rd-quote">{block.text}</blockquote>;
    case "list-item":
      return <li className="rd-li">{block.text}</li>;
    case "code":
      return <pre className="rd-code">{block.text}</pre>;
    case "paragraph":
      return <p className="rd-p">{block.text}</p>;
  }
}

const UNAVAILABLE_TEXT: Readonly<Record<ReaderUnavailableReason, string>> = {
  "no-page": "There is no page to read here.",
  "not-an-article": "This page does not look like an article, so there is nothing to lay out.",
  "extraction-failed": "This page could not be read. It may have navigated away."
};

function Article({ document }: { readonly document: ReaderDocument }): React.JSX.Element {
  return (
    <article className="rd-article">
      {document.title.length > 0 && <h1 className="rd-title">{document.title}</h1>}

      <p className="rd-meta">
        {document.site}
        {document.byline.length > 0 ? ` - ${document.byline}` : ""}
        {` - ${readingMinutes(document.wordCount)} min read`}
      </p>

      {document.blocks.map((block, index) => (
        // Index keys are correct here: the list is rendered once from an
        // immutable document and never reordered or spliced.
        <Block key={index} block={block} />
      ))}

      {document.truncated && (
        <p className="rd-truncated">
          This article was longer than reader mode will lay out, so it stops here.
        </p>
      )}
    </article>
  );
}

/**
 * Reader mode: the page's text, and nothing else.
 *
 * Local by construction. Nothing was fetched to build this and nothing is sent
 * anywhere to display it - the text came from the DOM the page had already
 * loaded, with the markup, scripts, images, and styling taken away.
 */
export function ReaderView({
  state,
  onClose
}: {
  /** Never `closed`: the caller mounts this only when there is something to show. */
  readonly state: Exclude<ReaderState, { status: "closed" }>;
  readonly onClose: () => void;
}): React.JSX.Element {
  /*
   * The closed case is handled by not rendering this component at all, rather
   * than by returning null from inside it. Returning early would put the hooks
   * below behind a condition, and it would also keep the component mounted with
   * no content - so the focus trap would run once against an empty ref and never
   * again. Mounting on open is what makes focus move in every time.
   */
  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  return (
    <section className="reader glass" role="dialog" ref={trapRef} aria-label="Reader mode">
      <header className="rd-head">
        <span className="eyebrow">Reader</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close reader">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="rd-body">
        {state.status === "ready" ? (
          <Article document={state.document} />
        ) : (
          <p className="rd-empty">{UNAVAILABLE_TEXT[state.reason]}</p>
        )}
      </div>
    </section>
  );
}
