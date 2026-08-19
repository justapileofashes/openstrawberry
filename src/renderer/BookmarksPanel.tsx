import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  MAX_BOOKMARK_QUERY_LENGTH,
  type BookmarkPage
} from "../shared/bookmarks.js";

/**
 * The imported bookmarks.
 *
 * Migration has been able to import bookmarks for a while; until now nothing
 * read the file it wrote, so the work was invisible. This is that read path.
 *
 * Every string rendered here came from another browser's export. It is bounded
 * and cleaned in the trusted process and lands in React text nodes, so a title
 * crafted to look like markup shows as the text it is.
 */
export function BookmarksPanel({
  page,
  query,
  onQueryChange,
  onOpen,
  onClose
}: {
  readonly page: BookmarkPage;
  readonly query: string;
  readonly onQueryChange: (next: string) => void;
  readonly onOpen: (url: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  return (
    <aside className="settings glass" role="dialog" ref={trapRef} aria-label="Bookmarks">
      <header className="set-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>Bookmarks</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close bookmarks">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        <input
          ref={inputRef}
          className="bm-search"
          type="text"
          value={query}
          maxLength={MAX_BOOKMARK_QUERY_LENGTH}
          placeholder="Search bookmarks"
          aria-label="Search bookmarks"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onQueryChange(event.target.value)}
        />

        {page.entries.length === 0 ? (
          <p className="bm-empty">
            {query.trim().length > 0
              ? "Nothing matches that."
              : "No bookmarks yet. Import them from another browser in Settings."}
          </p>
        ) : (
          <>
            {/*
              The count is stated whenever the list is a prefix, so a search that
              found more than fits never looks like it found only this many.
            */}
            <p className="bm-count" aria-live={focused ? "polite" : "off"}>
              {page.truncated
                ? `Showing ${page.entries.length} of ${page.total}`
                : `${page.total} ${page.total === 1 ? "bookmark" : "bookmarks"}`}
            </p>

            <ul className="bm-list">
              {page.entries.map((entry) => (
                <li key={`${entry.folder}|${entry.url}`} className="bm-item">
                  <button
                    type="button"
                    className="bm-open"
                    onClick={() => onOpen(entry.url)}
                    title={entry.url}
                  >
                    <span className="bm-title">
                      {entry.title.length > 0 ? entry.title : entry.url}
                    </span>
                    <span className="bm-meta">
                      {entry.folder.length > 0 ? `${entry.folder} - ` : ""}
                      {entry.url}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
