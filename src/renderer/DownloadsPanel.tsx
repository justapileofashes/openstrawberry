import { useRef } from "react";
import { FolderOpen, Pause, Play, X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  actionsFor,
  describeProgress,
  forDisplay,
  progressFraction
} from "./download-chrome.js";
import type { DownloadItem, DownloadSnapshot } from "../shared/downloads.js";

/**
 * One download.
 *
 * The controls offered come from `actionsFor` rather than from inline checks, so
 * the markup cannot drift from the rule about what a given state permits.
 */
function Item({
  item,
  onPause,
  onResume,
  onCancel,
  onReveal
}: {
  readonly item: DownloadItem;
  readonly onPause: (id: string) => void;
  readonly onResume: (id: string) => void;
  readonly onCancel: (id: string) => void;
  readonly onReveal: (id: string) => void;
}): React.JSX.Element {
  const actions = actionsFor(item);
  const fraction = progressFraction(item);
  const failed = item.state === "interrupted" || item.state === "cancelled";

  return (
    <li className={`dl-item${failed ? " is-failed" : ""}`}>
      <div className="dl-main">
        {/* `title` carries the full name, which the row itself truncates. */}
        <span className="dl-name" title={item.fileName}>
          {item.fileName}
        </span>
        <span className="dl-meta">
          {item.host.length > 0 ? `${item.host} - ` : ""}
          {describeProgress(item)}
        </span>

        {!actions.canReveal && !failed && (
          <div
            className="dl-bar"
            role="progressbar"
            aria-label={`Downloading ${item.fileName}`}
            {...(fraction === null
              ? {}
              : {
                  "aria-valuenow": Math.round(fraction * 100),
                  "aria-valuemin": 0,
                  "aria-valuemax": 100
                })}
          >
            <span
              className={`dl-fill${fraction === null ? " is-indeterminate" : ""}`}
              style={fraction === null ? undefined : { inlineSize: `${fraction * 100}%` }}
            />
          </div>
        )}
      </div>

      <div className="dl-actions">
        {actions.canPause && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onPause(item.id)}
            aria-label={`Pause ${item.fileName}`}
          >
            <Pause size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
        {actions.canResume && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onResume(item.id)}
            aria-label={`Resume ${item.fileName}`}
          >
            <Play size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
        {actions.canReveal && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onReveal(item.id)}
            aria-label={`Show ${item.fileName} in folder`}
          >
            <FolderOpen size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
        {actions.canCancel && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => onCancel(item.id)}
            aria-label={`Cancel ${item.fileName}`}
          >
            <X size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * The downloads panel.
 *
 * A glass sheet anchored to the chrome, like the settings panel: pages are
 * native views the compositor draws above the DOM, so no panel can overlay page
 * content.
 *
 * Every action sends an id. The panel never sees or sends a path - it is told a
 * folder label, which is why the footer can say where files go without the
 * renderer knowing where that is.
 */
export function DownloadsPanel({
  snapshot,
  onPause,
  onResume,
  onCancel,
  onReveal,
  onClearFinished,
  onClose
}: {
  readonly snapshot: DownloadSnapshot;
  readonly onPause: (id: string) => void;
  readonly onResume: (id: string) => void;
  readonly onCancel: (id: string) => void;
  readonly onReveal: (id: string) => void;
  readonly onClearFinished: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const items = forDisplay(snapshot.items);
  const folder = items[0]?.directoryLabel ?? "Downloads";
  const hasFinished = items.some((item) => actionsFor(item).canCancel === false);

  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  return (
    <aside className="settings glass" role="dialog" ref={trapRef} aria-label="Downloads">
      <header className="set-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>Downloads</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close downloads">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        {items.length === 0 ? (
          <p className="dl-empty">
            Nothing downloaded yet. Files you save will appear here and go to your {folder} folder.
          </p>
        ) : (
          <ul className="dl-list">
            {items.map((item) => (
              <Item
                key={item.id}
                item={item}
                onPause={onPause}
                onResume={onResume}
                onCancel={onCancel}
                onReveal={onReveal}
              />
            ))}
          </ul>
        )}
      </div>

      {hasFinished && (
        <footer className="set-foot">
          <button type="button" className="text-btn" onClick={onClearFinished}>
            Clear finished
          </button>
          {/* Said plainly, because a list that clears files would be a nasty surprise. */}
          <span className="set-hint">Clears this list only. Your files are not deleted.</span>
        </footer>
      )}
    </aside>
  );
}
