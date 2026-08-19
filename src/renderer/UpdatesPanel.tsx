import { useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  canCheck,
  canDownload,
  canInstall,
  type UpdateBlocker,
  type UpdateErrorCode,
  type UpdateState
} from "../shared/updates.js";

/**
 * Why the channel is off, in words.
 *
 * Each names a different fix. Telling someone "updates are unavailable" for a
 * development build and for an unsigned release helps neither of them.
 */
const BLOCKER_TEXT: Readonly<Record<UpdateBlocker, string>> = {
  "not-packaged": "This is a development build, which never replaces itself.",
  "not-release-ready":
    "There are no signed artifacts yet, so an update could not be verified as genuine.",
  "channel-disabled": "The update channel is switched off in this build."
};

/** Held here rather than taken from a release server, which is remote content. */
const ERROR_TEXT: Readonly<Record<UpdateErrorCode, string>> = {
  network: "The update server could not be reached.",
  "metadata-invalid": "The release information could not be read.",
  "signature-invalid": "The update was not signed by this application's key.",
  "download-failed": "The download did not complete.",
  "install-failed": "The update could not be installed."
};

/**
 * The update channel.
 *
 * The disabled state is the one this build actually shows, and it is written to
 * be informative rather than apologetic: it says what would have to be true, so
 * a reader can tell whether this is a limitation of their copy or of the project.
 */
export function UpdatesPanel({
  state,
  onCheck,
  onDownload,
  onInstall,
  onClose
}: {
  readonly state: UpdateState;
  readonly onCheck: () => void;
  readonly onDownload: () => void;
  readonly onInstall: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  return (
    <aside className="settings glass" role="dialog" ref={trapRef} aria-label="Updates">
      <header className="set-head">
        <div>
          <span className="eyebrow">Application</span>
          <h2>Updates</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close updates">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        {state.status === "disabled" && (
          <>
            <p className="up-status">Updates are turned off for this build.</p>
            <ul className="up-blockers">
              {state.blockers.map((blocker) => (
                <li key={blocker}>{BLOCKER_TEXT[blocker]}</li>
              ))}
            </ul>
            <p className="set-hint">
              Nothing is downloaded or installed while this is the case, and no request is made
              to a release server.
            </p>
          </>
        )}

        {state.status === "idle" && (
          <p className="up-status">You are on version {state.currentVersion}.</p>
        )}

        {state.status === "checking" && <p className="up-status">Checking for updates…</p>}

        {state.status === "available" && (
          <p className="up-status">Version {state.version} is available.</p>
        )}

        {state.status === "downloading" && (
          <>
            <p className="up-status">
              Downloading version {state.version} — {state.percent}%
            </p>
            {/* A real progress element, so assistive technology reads it. */}
            <progress className="up-progress" max={100} value={state.percent} />
          </>
        )}

        {state.status === "downloaded" && (
          <p className="up-status">
            Version {state.version} is ready. It installs when you restart — nothing is replaced
            while you are working.
          </p>
        )}

        {state.status === "error" && <p className="up-status">{ERROR_TEXT[state.code]}</p>}

        {/*
          Every action is derived from the state rather than tracked beside it,
          so a button and its handler cannot disagree about what is possible.
        */}
        <div className="up-actions">
          <button type="button" className="text-btn" onClick={onCheck} disabled={!canCheck(state)}>
            Check for updates
          </button>
          {canDownload(state) && (
            <button type="button" className="text-btn" onClick={onDownload}>
              Download
            </button>
          )}
          {canInstall(state) && (
            <button type="button" className="text-btn" onClick={onInstall}>
              Restart and install
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
