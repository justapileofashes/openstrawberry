import { X } from "lucide-react";
import {
  DEFAULT_APPEARANCE,
  shineDurationSeconds,
  type AppearanceSettings
} from "../shared/settings.js";
import type { MigrationOverview } from "../shared/migration.js";

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
  onDeleteStagedPasswords
}: {
  readonly settings: AppearanceSettings;
  readonly onChange: (next: AppearanceSettings) => void;
  readonly onClose: () => void;
  /** Null while the overview is loading, or if migration is unavailable. */
  readonly migration: MigrationOverview | null;
  readonly onRunMigration: () => void;
  readonly onDeleteStagedPasswords: () => void;
}): React.JSX.Element {
  const patch = (part: Partial<AppearanceSettings>): void =>
    onChange({ ...settings, ...part });

  return (
    <aside className="settings glass" role="dialog" aria-label="Appearance settings">
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
