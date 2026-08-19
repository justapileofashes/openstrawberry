import { useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  DEFAULT_APPEARANCE,
  shineDurationSeconds,
  type AppearanceSettings
} from "../shared/settings.js";
import type { MigrationOverview } from "../shared/migration.js";
import {
  canPressSetDefault,
  type DefaultBrowserState
} from "../shared/default-browser.js";

/**
 * What the default-browser row says, for each state the request can be in.
 *
 * The wording is here rather than in the trusted process for the usual reason:
 * a state is a code, and codes are what cross IPC. It is also the only place
 * that knows Windows finishes elsewhere, which is the one thing a person must
 * be told before they press the button and go looking for a confirmation that
 * is not coming.
 */
function defaultBrowserHint(state: DefaultBrowserState | null): string {
  if (state === null) return "Checking with the system.";

  switch (state.status) {
    case "default":
      return "Links from other applications open here.";
    case "pending":
      return "Windows asks you to confirm. Pick OpenStrawberry under Web browser in Settings.";
    case "not-default":
      return state.method === "system-settings"
        ? "Opens Windows Settings, where the choice is yours to make."
        : "Links from other applications will open here.";
    case "unavailable":
      return state.blockers.includes("not-packaged")
        ? "Only an installed build can register itself, so this development run will not."
        : "This system has no way to be asked.";
  }
}

function defaultBrowserLabel(state: DefaultBrowserState | null): string {
  if (state !== null && state.status === "pending") return "Open Settings again";
  return "Set as default";
}

function Row({
  label,
  hint,
  control
}: {
  readonly label: string;
  readonly hint: string;
  readonly control: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="set-row">
      <div className="set-label">
        {label}
        <span className="set-hint">{hint}</span>
      </div>
      <div className="set-control">{control}</div>
    </div>
  );
}

/**
 * Appearance settings.
 *
 * The panel is a glass sheet over the chrome. It cannot overlay page content,
 * because pages are native views the compositor draws above the DOM, so it is
 * anchored to the chrome region instead.
 */
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  migration,
  onRunMigration,
  onDeleteStagedPasswords,
  defaultBrowser,
  onSetDefaultBrowser
}: {
  readonly settings: AppearanceSettings;
  readonly onChange: (next: AppearanceSettings) => void;
  readonly onClose: () => void;
  /** Null while the system is still being asked. */
  readonly defaultBrowser: DefaultBrowserState | null;
  readonly onSetDefaultBrowser: () => void;
  /** Null while the overview is loading, or if migration is unavailable. */
  readonly migration: MigrationOverview | null;
  readonly onRunMigration: () => void;
  readonly onDeleteStagedPasswords: () => void;
}): React.JSX.Element {
  const patch = (part: Partial<AppearanceSettings>): void =>
    onChange({ ...settings, ...part });

  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  return (
    <aside className="settings glass" role="dialog" ref={trapRef} aria-label="Appearance settings">
      <header className="set-head">
        <div>
          <span className="eyebrow">Obsidian Relay</span>
          <h2>Appearance</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        <Row
          label="Shine"
          hint="The drifting highlight across glass surfaces."
          control={
            <button
              type="button"
              role="switch"
              aria-checked={settings.shineEnabled}
              className={`switch${settings.shineEnabled ? " is-on" : ""}`}
              onClick={() => patch({ shineEnabled: !settings.shineEnabled })}
            >
              <span className="switch-dot" />
            </button>
          }
        />

        <Row
          label="Intensity"
          hint={`Peak brightness of the shine. ${settings.shineIntensity}%`}
          control={
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={settings.shineIntensity}
              disabled={!settings.shineEnabled}
              aria-label="Shine intensity"
              onChange={(event) => patch({ shineIntensity: Number(event.target.value) })}
            />
          }
        />

        <Row
          label="Speed"
          hint={`One drift cycle takes ${shineDurationSeconds(settings.shineSpeed)}s.`}
          control={
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={settings.shineSpeed}
              disabled={!settings.shineEnabled || !settings.motionEnabled}
              aria-label="Shine speed"
              onChange={(event) => patch({ shineSpeed: Number(event.target.value) })}
            />
          }
        />

        <Row
          label="Colour"
          hint="Defaults to a near-white specular tone."
          control={
            <span className="swatch-field">
              <input
                type="color"
                value={settings.shineColor}
                disabled={!settings.shineEnabled}
                aria-label="Shine colour"
                onChange={(event) => patch({ shineColor: event.target.value })}
              />
              <code>{settings.shineColor}</code>
            </span>
          }
        />

        {/*
          Placed under the shine controls it modifies rather than beside the
          media controls, because what it changes is the highlight. The hint
          names the whole machine rather than the page: loopback hears the
          system mix, so a track playing in another application moves the field
          too, and someone would otherwise reasonably read this as "reacts to
          tabs".
        */}
        <Row
          label="React to audio"
          hint="The shine speeds up and brightens with whatever the machine is playing."
          control={
            <button
              type="button"
              role="switch"
              aria-checked={settings.audioReactive}
              className={`switch${settings.audioReactive ? " is-on" : ""}`}
              disabled={!settings.shineEnabled || !settings.motionEnabled}
              onClick={() => patch({ audioReactive: !settings.audioReactive })}
            >
              <span className="switch-dot" />
            </button>
          }
        />

        <Row
          label="Motion"
          hint="Turns off non-essential movement. Glass itself stays."
          control={
            <button
              type="button"
              role="switch"
              aria-checked={settings.motionEnabled}
              className={`switch${settings.motionEnabled ? " is-on" : ""}`}
              onClick={() => patch({ motionEnabled: !settings.motionEnabled })}
            >
              <span className="switch-dot" />
            </button>
          }
        />

        {/*
          The one row here that changes something outside the application. It
          states the outcome before the press rather than after it, because on
          Windows the press only opens Settings, and a button that quietly does
          less than its label says is worse than one that says less.
        */}
        <Row
          label="Default browser"
          hint={defaultBrowserHint(defaultBrowser)}
          control={
            defaultBrowser !== null && defaultBrowser.status === "default" ? (
              <span className="set-note">Already default</span>
            ) : (
              <button
                type="button"
                className="text-btn"
                disabled={defaultBrowser === null || !canPressSetDefault(defaultBrowser)}
                onClick={onSetDefaultBrowser}
              >
                {defaultBrowserLabel(defaultBrowser)}
              </button>
            )
          }
        />

        {migration !== null && (
          <>
            {/*
              Re-entry, and the plain warning that goes with it. Running again is
              useful — a second browser, a category skipped the first time — but a
              second bookmark import can duplicate the first, and the wizard says
              so rather than letting the user discover it afterwards.
            */}
            <Row
              label="Migration"
              hint={
                migration.state.status === "completed"
                  ? `${migration.state.totalBookmarkCount} bookmarks saved. Running again can create duplicates unless the wizard's skip option stays on.`
                  : "Bring across bookmarks or a search engine name from another browser. Review first, category by category."
              }
              control={
                <button type="button" className="text-btn" onClick={onRunMigration}>
                  {migration.state.status === "pending" ? "Run migration" : "Run migration again"}
                </button>
              }
            />

            {migration.stagedPasswordCount > 0 && (
              <Row
                label="Staged passwords"
                hint={`${migration.stagedPasswordCount} entries, encrypted by this system. They are never filled in automatically and cannot be shown again.`}
                control={
                  <button type="button" className="text-btn" onClick={onDeleteStagedPasswords}>
                    Delete all
                  </button>
                }
              />
            )}
          </>
        )}
      </div>

      <footer className="set-foot">
        <button
          type="button"
          className="text-btn"
          onClick={() => onChange(DEFAULT_APPEARANCE)}
        >
          Reset to defaults
        </button>
      </footer>
    </aside>
  );
}
