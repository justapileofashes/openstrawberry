/**
 * The window's own minimise, maximise, and close controls.
 *
 * The system title bar is hidden on every platform except macOS, which keeps its
 * native traffic lights, so these are the only frame controls the user has.
 * `usesCustomWindowControls` decides which case applies and is the same function
 * the main process consults when choosing the title-bar style.
 *
 * The glyphs are drawn here rather than taken from the icon set: window controls
 * are 10px marks with square ends, and a general-purpose icon at that size reads
 * as a smudge. They match the platform vocabulary — line, square, cross — in the
 * chrome's own weight.
 */
import { useEffect, useState } from "react";
import type { WindowState } from "../shared/bridge.js";

const GLYPH_STROKE = 1.1;

function Minimise(): React.JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d="M0.5 5 H9.5" stroke="currentColor" strokeWidth={GLYPH_STROKE} />
    </svg>
  );
}

function Maximise(): React.JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect
        x="0.75"
        y="0.75"
        width="8.5"
        height="8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={GLYPH_STROKE}
      />
    </svg>
  );
}

/** Two offset outlines, the conventional mark for leaving a maximised frame. */
function Restore(): React.JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path
        d="M2.6 2.6 V0.75 H9.25 V7.4 H7.4"
        fill="none"
        stroke="currentColor"
        strokeWidth={GLYPH_STROKE}
      />
      <rect
        x="0.75"
        y="2.6"
        width="6.65"
        height="6.65"
        fill="none"
        stroke="currentColor"
        strokeWidth={GLYPH_STROKE}
      />
    </svg>
  );
}

function Close(): React.JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path
        d="M0.8 0.8 L9.2 9.2 M9.2 0.8 L0.8 9.2"
        stroke="currentColor"
        strokeWidth={GLYPH_STROKE}
      />
    </svg>
  );
}

export function WindowControls(): React.JSX.Element {
  const frame = window.openstrawberry.window;
  const [state, setState] = useState<WindowState>({ isMaximized: false, isFullScreen: false });

  // The frame also changes from snap gestures and keyboard shortcuts the chrome
  // never sees, so the glyph follows pushed state rather than the last request.
  useEffect(() => {
    const unsubscribe = frame.onState(setState);
    void frame.getState().then(setState);
    return unsubscribe;
  }, [frame]);

  const maximiseLabel = state.isMaximized ? "Restore down" : "Maximise";

  return (
    <div className="window-controls">
      <button
        type="button"
        className="icon-btn win-btn"
        onClick={() => void frame.minimize()}
        aria-label="Minimise"
        title="Minimise"
      >
        <Minimise />
      </button>
      <button
        type="button"
        className="icon-btn win-btn"
        onClick={() => void frame.toggleMaximize()}
        // Full screen has its own exit, so the control is inert there rather
        // than appearing to do nothing.
        disabled={state.isFullScreen}
        aria-label={maximiseLabel}
        title={maximiseLabel}
      >
        {state.isMaximized ? <Restore /> : <Maximise />}
      </button>
      <button
        type="button"
        className="icon-btn win-btn is-close"
        onClick={() => void frame.close()}
        aria-label="Close window"
        title="Close"
      >
        <Close />
      </button>
    </div>
  );
}
