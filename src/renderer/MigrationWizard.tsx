import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, FileText, KeyRound, Loader2, Sparkles, X } from "lucide-react";
import {
  describeWarning,
  type DetectedBrowser,
  type MigrationOverview,
  type MigrationWarning
} from "../shared/migration.js";
import {
  NEVER_IMPORTED,
  beginPath,
  canReadSource,
  categoryAvailability,
  chooseProfile,
  commitRequest,
  encryptionExplanation,
  exportInstructions,
  findBrowser,
  findProfile,
  goToConfirm,
  handleToRelease,
  hasSomethingToImport,
  initialWizardState,
  passwordStagingAvailable,
  pathLimitations,
  setDeduplicate,
  stepBack,
  stepIndex,
  toggleCategory,
  withBookmarkReview,
  withError,
  withPasswordReview,
  withResult,
  withWorking,
  type WizardPath,
  type WizardState
} from "./migration-wizard.js";

/** The step labels the rail shows. Indexes line up with `WIZARD_STEPS`. */
const STEP_LABELS: readonly string[] = [
  "Welcome",
  "Path",
  "Source",
  "Preview",
  "Confirm",
  "Done"
];

function Warnings({ warnings }: { readonly warnings: readonly MigrationWarning[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null;

  return (
    <ul className="mig-warnings" aria-label="Warnings">
      {warnings.map((warning) => (
        <li key={warning.code}>
          <AlertTriangle size={12} strokeWidth={1.6} aria-hidden="true" />
          <span>
            {describeWarning(warning)}
            {warning.count > 0 && <span className="mig-count"> {warning.count}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A category toggle. Off unless the user turns it on, and inert when unavailable. */
function Category({
  label,
  hint,
  checked,
  available,
  onToggle
}: {
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly available: boolean;
  readonly onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={!available}
      className={`mig-check${checked ? " is-on" : ""}`}
      onClick={onToggle}
    >
      <span className="mig-check-box" aria-hidden="true">
        {checked && <Check size={11} strokeWidth={2.4} />}
      </span>
      <span className="mig-check-text">
        {label}
        <span className="mig-check-hint">{hint}</span>
      </span>
    </button>
  );
}

function PathCard({
  title,
  hint,
  icon,
  onChoose
}: {
  readonly title: string;
  readonly hint: string;
  readonly icon: React.ReactNode;
  readonly onChoose: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="mig-path" onClick={onChoose}>
      <span className="mig-path-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="mig-path-text">
        <span className="mig-path-title">{title}</span>
        <span className="mig-path-hint">{hint}</span>
      </span>
    </button>
  );
}

/**
 * The first-launch migration wizard.
 *
 * Review-first by construction: every screen before `confirm` is either a choice
 * or a description of what was found, and the only call that writes anything is
 * behind the confirm action. Every screen also keeps "Start fresh instead"
 * reachable, so no state in this flow is a dead end — including the error states,
 * which render as a message beside the same controls rather than replacing them.
 *
 * While this is open the panes collapse to nothing, because a page is a native
 * view the compositor draws above the DOM and a modal over a live pane would be
 * drawn behind it.
 */
export function MigrationWizard({
  overview,
  onOverview,
  onClose
}: {
  readonly overview: MigrationOverview;
  readonly onOverview: (next: MigrationOverview) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const bridge = window.openstrawberry.migration;
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [phase, setPhase] = useState("");
  const surface = useRef<HTMLElement>(null);

  // Focus moves into the dialog on open, so a keyboard user is not left behind
  // in the chrome with a modal they cannot reach.
  useEffect(() => {
    surface.current?.focus();
  }, []);

  const available = categoryAvailability(state, overview);
  const browser = findBrowser(overview, state.sourceId);
  const profile = findProfile(overview, state.sourceId, state.profileId);
  const staging = passwordStagingAvailable(overview.encryption);

  const fail = useCallback((error: unknown): void => {
    // The message already crossed the router, which strips paths and stack
    // frames, so what arrives here is safe to render as written.
    setState((current) =>
      withError(
        current,
        error instanceof Error && error.message.length > 0
          ? error.message
          : "That step could not be completed."
      )
    );
    setPhase("");
  }, []);

  const startFresh = useCallback((): void => {
    void bridge
      .startFresh()
      .then((next) => {
        onOverview(next);
        onClose();
      })
      .catch(fail);
  }, [bridge, onOverview, onClose, fail]);

  const cancel = useCallback((): void => {
    void bridge
      .cancel()
      .then((next) => {
        onOverview(next);
        onClose();
      })
      .catch(fail);
  }, [bridge, onOverview, onClose, fail]);

  const finish = useCallback((): void => {
    void bridge
      .finish()
      .then((next) => {
        onOverview(next);
        onClose();
      })
      .catch(fail);
  }, [bridge, onOverview, onClose, fail]);

  const back = useCallback((): void => {
    const handle = handleToRelease(state);
    // Stepping back off a review releases what was read, in both processes.
    if (handle !== null) void bridge.releaseSelection(handle).catch(() => undefined);
    setState(stepBack(state));
    setPhase("");
  }, [bridge, state]);

  /** Performs the read the source step has been describing. */
  const readSource = useCallback((): void => {
    setState(withWorking(state));

    if (state.path === "chromium" && state.sourceId !== null && state.profileId !== null) {
      setPhase("Reading the selected profile…");
      void bridge
        .previewProfile(state.sourceId, state.profileId)
        .then((review) => {
          setPhase("");
          setState((current) => withBookmarkReview(current, review));
        })
        .catch(fail);
      return;
    }

    if (state.path === "firefox-html" || state.path === "safari-html") {
      setPhase("Waiting for a file to be chosen…");
      void bridge
        .pickBookmarksFile(state.path)
        .then((picked) => {
          setPhase("");
          // Dismissing the dialog is an ordinary outcome; the user returns to
          // the same screen rather than to an error.
          const review = picked.cancelled ? null : picked.result;
          if (review === null) {
            setState((current) => ({ ...current, status: "idle" }));
            return;
          }
          setState((current) => withBookmarkReview(current, review));
        })
        .catch(fail);
      return;
    }

    if (state.path === "password-csv") {
      setPhase("Waiting for a file to be chosen…");
      void bridge
        .pickPasswordFile()
        .then((picked) => {
          setPhase("");
          const review = picked.cancelled ? null : picked.result;
          if (review === null) {
            setState((current) => ({ ...current, status: "idle" }));
            return;
          }
          setState((current) => withPasswordReview(current, review));
        })
        .catch(fail);
      return;
    }

    setState((current) => ({ ...current, status: "idle" }));
  }, [bridge, state, fail]);

  const confirm = useCallback((): void => {
    const request = commitRequest(state);
    if (request === null) return;

    setState(withWorking(state));
    setPhase(
      request.stagePasswords
        ? "Encrypting the reviewed entries with operating-system encryption…"
        : "Saving the reviewed bookmarks…"
    );

    void bridge
      .commit(request)
      .then((result) => {
        setPhase("");
        setState((current) => withResult(current, result));
        void bridge.getOverview().then(onOverview).catch(() => undefined);
      })
      .catch(fail);
  }, [bridge, state, onOverview, fail]);

  const working = state.status === "working";
  const index = stepIndex(state.step);

  return (
    <section
      ref={surface}
      className="mig glass"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mig-title"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !working) cancel();
      }}
    >
      <header className="mig-head">
        <div className="mig-head-text">
          <span className="eyebrow">Migration</span>
          <h2 id="mig-title">{headingFor(state)}</h2>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={cancel}
          disabled={working}
          aria-label="Close migration"
        >
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <ol className="mig-rail" aria-label="Migration progress">
        {STEP_LABELS.map((label, position) => (
          <li
            key={label}
            className={`mig-rail-step${position === index ? " is-current" : ""}${
              position < index ? " is-done" : ""
            }`}
            aria-current={position === index ? "step" : undefined}
          >
            <span className="mig-rail-dot" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ol>

      <div className="mig-body">
        {state.step === "welcome" && (
          <>
            <p className="mig-lede">
              OpenStrawberry can bring across a few things from a browser you already
              use. Migration is optional, runs entirely on this machine, and happens
              one category at a time — nothing is copied until you have seen exactly
              what it is and confirmed it.
            </p>
            <ul className="mig-facts">
              <li>Nothing is read until you choose a source.</li>
              <li>Nothing leaves this machine. Migration makes no network requests.</li>
              <li>You see counts and a sample before anything is saved.</li>
              <li>No agent can reach anything migration reads or stores.</li>
            </ul>
            <NotImported path={null} />
          </>
        )}

        {state.step === "path" && (
          <>
            <p className="mig-lede">Choose how to start. You can change your mind at every step.</p>
            <div className="mig-paths">
              <PathCard
                title="Start fresh"
                hint="A clean OpenStrawberry profile. Nothing is read from any other browser."
                icon={<Sparkles size={16} strokeWidth={1.5} />}
                onChoose={startFresh}
              />
              {overview.sources.length > 0 && (
                <PathCard
                  title="A browser on this machine"
                  hint="Review bookmarks and the configured search engine name from a Chromium-based browser."
                  icon={<Check size={16} strokeWidth={1.5} />}
                  onChoose={() => setState(beginPath(state, "chromium", overview))}
                />
              )}
              <PathCard
                title="A Firefox bookmarks export"
                hint="Choose an HTML file you exported from Firefox."
                icon={<FileText size={16} strokeWidth={1.5} />}
                onChoose={() => setState(beginPath(state, "firefox-html", overview))}
              />
              <PathCard
                title="A Safari bookmarks export"
                hint="Choose an HTML file you exported from Safari."
                icon={<FileText size={16} strokeWidth={1.5} />}
                onChoose={() => setState(beginPath(state, "safari-html", overview))}
              />
              <PathCard
                title="Stage passwords from a CSV"
                hint="Reviewed, encrypted, never filled in automatically. A separate, opt-in flow."
                icon={<KeyRound size={16} strokeWidth={1.5} />}
                onChoose={() => setState(beginPath(state, "password-csv", overview))}
              />
            </div>

            {overview.sources.length === 0 && (
              <p className="mig-empty">
                No Chromium-based browser profile was found in the usual place for this
                system. That is not a fault — you can still import an export file, or
                start fresh.
              </p>
            )}
          </>
        )}

        {state.step === "source" && state.path === "chromium" && (
          <>
            <p className="mig-lede">
              Choose a profile, then the categories to review. Nothing is read until you
              continue.
            </p>
            <SourceList
              sources={overview.sources}
              sourceId={state.sourceId}
              profileId={state.profileId}
              onChoose={(sourceId, profileId) =>
                setState(chooseProfile(state, sourceId, profileId, overview))
              }
            />

            {profile !== null && (
              <div className="mig-categories">
                <Category
                  label="Bookmarks"
                  hint={
                    available.bookmarks
                      ? "Folders, titles, and web addresses."
                      : "This profile has no readable bookmark file."
                  }
                  checked={state.importBookmarks}
                  available={available.bookmarks}
                  onToggle={() => setState(toggleCategory(state, "bookmarks", overview))}
                />
                <Category
                  label="Search engine name"
                  hint={
                    available.searchName
                      ? "The provider's display name only — never its address template, keys, or account settings."
                      : "This profile has no readable preferences file."
                  }
                  checked={state.importDefaultSearchName}
                  available={available.searchName}
                  onToggle={() => setState(toggleCategory(state, "searchName", overview))}
                />
              </div>
            )}

            <NotImported path="chromium" />
          </>
        )}

        {state.step === "source" && state.path !== "chromium" && state.path !== null && (
          <>
            <p className="mig-lede">
              {state.path === "password-csv"
                ? "Passwords are staged from a file you choose, reviewed before anything is stored."
                : "Firefox and Safari keep bookmarks in databases that stay locked while the browser runs. OpenStrawberry never opens them. Export a file instead — it is the same data, handed over deliberately."}
            </p>

            <ol className="mig-instructions">
              {exportInstructions(state.path).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>

            {state.path === "password-csv" && !staging && (
              <p className="mig-notice is-bad">{encryptionExplanation(overview.encryption)}</p>
            )}

            <NotImported path={state.path} />
          </>
        )}

        {state.step === "preview" && (
          <Preview
            state={state}
            browserName={browser?.displayName ?? null}
            profileName={profile?.displayName ?? null}
            onToggleDeduplicate={(value) => setState(setDeduplicate(state, value))}
          />
        )}

        {state.step === "confirm" && (
          <Confirm state={state} browserName={browser?.displayName ?? null} />
        )}

        {state.step === "result" && state.result !== null && (
          <>
            <p className="mig-lede">Migration finished. Here is exactly what happened.</p>
            <dl className="mig-figures">
              <div>
                <dt>Bookmarks saved</dt>
                <dd>{state.result.importedBookmarkCount}</dd>
              </div>
              <div>
                <dt>Folders created</dt>
                <dd>{state.result.importedFolderCount}</dd>
              </div>
              <div>
                <dt>Duplicates skipped</dt>
                <dd>{state.result.skippedDuplicateCount}</dd>
              </div>
              <div>
                <dt>Passwords staged</dt>
                <dd>{state.result.stagedPasswordCount}</dd>
              </div>
            </dl>

            {state.result.importedSearchName && state.result.searchName !== null && (
              <p className="mig-notice">
                Search engine name set to {state.result.searchName}. The address template
                and every other search setting were left behind.
              </p>
            )}

            {state.result.stagedPasswordCount > 0 && (
              <p className="mig-notice">
                Staged entries are encrypted with this system&rsquo;s own encryption. They
                are never filled in automatically, never synced, and cannot be shown
                again. You can delete them at any time from Settings. Delete the CSV you
                exported — it is still an unencrypted file of your passwords.
              </p>
            )}

            <Warnings warnings={state.result.warnings} />
          </>
        )}

        {working && (
          <p className="mig-progress" role="status">
            <Loader2 size={13} strokeWidth={1.8} aria-hidden="true" />
            {phase.length > 0 ? phase : "Working…"}
          </p>
        )}

        {state.status === "error" && state.errorMessage !== null && (
          <p className="mig-notice is-bad" role="alert">
            {state.errorMessage} Nothing was changed. You can try again, step back, or
            start fresh.
          </p>
        )}
      </div>

      <footer className="mig-foot">
        {state.step === "result" ? (
          <button type="button" className="agent-btn" onClick={finish}>
            Finish
          </button>
        ) : (
          <>
            <button type="button" className="text-btn" onClick={startFresh} disabled={working}>
              Start fresh instead
            </button>
            <div className="mig-actions">
              {state.step !== "welcome" && (
                <button type="button" className="text-btn" onClick={back} disabled={working}>
                  Back
                </button>
              )}
              {state.step === "welcome" && (
                <button
                  type="button"
                  className="agent-btn"
                  onClick={() => setState({ ...state, step: "path" })}
                >
                  Continue
                </button>
              )}
              {state.step === "source" && (
                <button
                  type="button"
                  className="agent-btn"
                  onClick={readSource}
                  disabled={!canReadSource(state)}
                >
                  {state.path === "chromium" ? "Read and preview" : "Choose file…"}
                </button>
              )}
              {state.step === "preview" && (
                <button
                  type="button"
                  className="agent-btn"
                  onClick={() => setState(goToConfirm(state))}
                  disabled={working || !hasSomethingToImport(state)}
                >
                  Review and confirm
                </button>
              )}
              {state.step === "confirm" && (
                <button
                  type="button"
                  className="agent-btn"
                  onClick={confirm}
                  disabled={working || commitRequest(state) === null}
                >
                  {state.stagePasswords ? "Encrypt and stage" : "Import now"}
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* Screens                                                                    */
/* ------------------------------------------------------------------------- */

function headingFor(state: WizardState): string {
  switch (state.step) {
    case "welcome":
      return "Bring across only what you choose";
    case "path":
      return "Where should OpenStrawberry look?";
    case "source":
      return state.path === "password-csv" ? "Choose a password export" : "Choose what to read";
    case "preview":
      return "This is what was found";
    case "confirm":
      return "Confirm before anything is saved";
    default:
      return "Migration complete";
  }
}

function SourceList({
  sources,
  sourceId,
  profileId,
  onChoose
}: {
  readonly sources: readonly DetectedBrowser[];
  readonly sourceId: string | null;
  readonly profileId: string | null;
  readonly onChoose: (sourceId: string, profileId: string) => void;
}): React.JSX.Element {
  return (
    <ul className="mig-sources">
      {sources.map((source) => (
        <li key={source.id}>
          <span className="mig-source-name">{source.displayName}</span>
          <div className="mig-profiles">
            {source.profiles.map((entry) => {
              const isChosen = sourceId === source.id && profileId === entry.id;
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`mig-profile${isChosen ? " is-chosen" : ""}`}
                  aria-pressed={isChosen}
                  onClick={() => onChoose(source.id, entry.id)}
                >
                  {entry.displayName}
                </button>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The fixed list of what migration never touches, plus this path's own limits. */
function NotImported({ path }: { readonly path: WizardPath | null }): React.JSX.Element {
  return (
    <div className="mig-never">
      <h3>Never imported, on any path</h3>
      <ul>
        {NEVER_IMPORTED.map((entry) => (
          <li key={entry}>{entry}</li>
        ))}
      </ul>
      {pathLimitations(path).map((line) => (
        <p className="mig-note" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

function Preview({
  state,
  browserName,
  profileName,
  onToggleDeduplicate
}: {
  readonly state: WizardState;
  readonly browserName: string | null;
  readonly profileName: string | null;
  readonly onToggleDeduplicate: (value: boolean) => void;
}): React.JSX.Element {
  const bookmarks = state.bookmarkReview;
  const passwords = state.passwordReview;

  return (
    <>
      <p className="mig-lede">
        {browserName !== null && profileName !== null
          ? `Read from ${browserName}, profile ${profileName}. Nothing has been saved yet.`
          : "Read from the file you chose. Nothing has been saved yet."}
      </p>

      {bookmarks !== null && (
        <section className="mig-section">
          <h3>
            Bookmarks
            <span className="mig-count">
              {bookmarks.preview.bookmarkCount} in {bookmarks.preview.folderCount} folders
            </span>
          </h3>

          {bookmarks.preview.bookmarkCount === 0 ? (
            <p className="mig-empty">
              No importable bookmarks were found here. You can step back and choose a
              different source, or start fresh.
            </p>
          ) : (
            <>
              <ul className="mig-sample" aria-label="Sample of bookmarks found">
                {bookmarks.preview.sample.map((entry) => (
                  <li key={`${entry.url}${entry.title}`}>
                    <span className="mig-sample-title">{entry.title}</span>
                    <span className="mig-sample-url">{entry.url}</span>
                  </li>
                ))}
              </ul>
              <p className="mig-note">
                A sample of the first {bookmarks.preview.sample.length}, shown for
                recognition only. It is discarded when this wizard closes.
              </p>
            </>
          )}

          <Warnings warnings={bookmarks.preview.warnings} />
        </section>
      )}

      {bookmarks !== null && bookmarks.defaultSearchName !== null && (
        <section className="mig-section">
          <h3>Search engine</h3>
          <p className="mig-note">
            Configured provider: <strong>{bookmarks.defaultSearchName}</strong>. Only this
            name would be carried across — not the search address template, the suggestion
            endpoint, any key, or any account setting.
          </p>
        </section>
      )}

      {passwords !== null && (
        <section className="mig-section">
          <h3>
            Passwords
            <span className="mig-count">{passwords.preview.validRows} ready to stage</span>
          </h3>
          <dl className="mig-figures">
            <div>
              <dt>Rows in file</dt>
              <dd>{passwords.preview.totalRows}</dd>
            </div>
            <div>
              <dt>Valid</dt>
              <dd>{passwords.preview.validRows}</dd>
            </div>
            <div>
              <dt>Rejected</dt>
              <dd>{passwords.preview.rejectedRows}</dd>
            </div>
          </dl>

          {passwords.preview.detectedColumns.length > 0 && (
            <p className="mig-note">
              Columns recognised: {passwords.preview.detectedColumns.join(", ")}. No value
              from this file is shown here, or anywhere else.
            </p>
          )}

          {passwords.preview.validRows === 0 && (
            <p className="mig-empty">
              Nothing in this file can be staged. You can step back and choose a different
              file, or start fresh.
            </p>
          )}

          <Warnings warnings={passwords.preview.warnings} />
        </section>
      )}

      {state.importBookmarks && (
        <button
          type="button"
          role="checkbox"
          aria-checked={state.deduplicate}
          className={`mig-check${state.deduplicate ? " is-on" : ""}`}
          onClick={() => onToggleDeduplicate(!state.deduplicate)}
        >
          <span className="mig-check-box" aria-hidden="true">
            {state.deduplicate && <Check size={11} strokeWidth={2.4} />}
          </span>
          <span className="mig-check-text">
            Skip bookmarks already saved
            <span className="mig-check-hint">
              A bookmark counts as already saved only when both its address and its folder
              match. Turning this off will create duplicates if you have migrated before.
            </span>
          </span>
        </button>
      )}
    </>
  );
}

function Confirm({
  state,
  browserName
}: {
  readonly state: WizardState;
  readonly browserName: string | null;
}): React.JSX.Element {
  const bookmarkCount = state.bookmarkReview?.preview.bookmarkCount ?? 0;
  const passwordCount = state.passwordReview?.preview.validRows ?? 0;

  return (
    <>
      <p className="mig-lede">
        Nothing has been written yet. Confirming performs exactly the following, and
        nothing else.
      </p>

      <ul className="mig-confirm">
        {state.importBookmarks && (
          <li>
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            Save {bookmarkCount} bookmarks
            {browserName !== null ? ` from ${browserName}` : ""}
            {state.deduplicate ? ", skipping any already saved in the same folder" : ""}.
          </li>
        )}
        {state.importDefaultSearchName && (
          <li>
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            Set the search engine name to{" "}
            {state.bookmarkReview?.defaultSearchName ?? "the configured provider"}.
          </li>
        )}
        {state.stagePasswords && (
          <li>
            <Check size={13} strokeWidth={2} aria-hidden="true" />
            Encrypt and stage {passwordCount} password entries.
          </li>
        )}
      </ul>

      {state.stagePasswords && (
        <div className="mig-callout">
          <h3>Before staging passwords</h3>
          <ul>
            <li>
              Entries are encrypted with this system&rsquo;s own encryption and written to
              OpenStrawberry&rsquo;s private application data.
            </li>
            <li>
              They are <strong>never filled in automatically</strong>, never synced, and
              never sent anywhere.
            </li>
            <li>
              After staging, the values cannot be displayed again — not by this wizard, not
              by any panel, and not by any agent.
            </li>
            <li>You can delete every staged entry at any time from Settings.</li>
          </ul>
        </div>
      )}

      <NotImported path={state.path} />
    </>
  );
}
