/**
 * The update channel's runtime, and the refusal in front of it.
 *
 * Every command here re-asks the gate rather than trusting a decision made at
 * construction. That is deliberate: a manager built once and consulted many
 * times is exactly where a stale "allowed" would sit, and the thing on the other
 * side of it downloads and runs code.
 *
 * Nothing in this file talks to a release server. `electron-updater` is a
 * dependency and is not imported: wiring it in is the step that comes *after*
 * signed artifacts exist, and leaving the import out means a build cannot start
 * downloading because someone flipped a constant. What exists today is the gate,
 * the state machine, and the refusals - all of which are the parts worth having
 * right before anything is fetched.
 */
import {
  initialUpdateState,
  isUpdateAllowed,
  updateBlockers,
  type UpdateEnvironment,
  type UpdateState
} from "../shared/updates.js";

export interface UpdateManagerOptions {
  readonly environment: UpdateEnvironment;
  readonly currentVersion: string;
  readonly publish: (state: UpdateState) => void;
}

export class UpdateManager {
  private readonly environment: UpdateEnvironment;
  private readonly currentVersion: string;
  private readonly publish: (state: UpdateState) => void;

  private state: UpdateState;
  private destroyed = false;

  public constructor(options: UpdateManagerOptions) {
    this.environment = options.environment;
    this.currentVersion = options.currentVersion;
    this.publish = options.publish;
    this.state = initialUpdateState(options.environment, options.currentVersion);
  }

  public snapshot(): UpdateState {
    return this.state;
  }

  /**
   * Asks whether anything is newer.
   *
   * Refuses while the gate is closed, and says why. Today it also refuses when
   * the gate is open, because no transport is wired: reporting an error the user
   * could act on would be a lie about what this build can do.
   */
  public check(): UpdateState {
    if (!this.allowed()) return this.refuse();

    // The honest state for a gate that opens onto nothing yet.
    return this.moveTo({ status: "error", code: "metadata-invalid" });
  }

  public download(): UpdateState {
    if (!this.allowed()) return this.refuse();
    return this.moveTo({ status: "error", code: "download-failed" });
  }

  /**
   * Restarts into a downloaded update.
   *
   * Separate from downloading on purpose. An updater that installs what it
   * fetched is one that decides when your work is interrupted.
   */
  public install(): UpdateState {
    if (!this.allowed()) return this.refuse();
    return this.moveTo({ status: "error", code: "install-failed" });
  }

  public destroy(): void {
    this.destroyed = true;
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  /** Re-asked on every command, never cached. */
  private allowed(): boolean {
    return isUpdateAllowed(this.environment);
  }

  /**
   * Returns to `disabled`, carrying the reasons.
   *
   * A refusal restates the whole gate rather than leaving whatever state the
   * channel was last in, so a build that should never update cannot be left
   * displaying `available`.
   */
  private refuse(): UpdateState {
    return this.moveTo({
      status: "disabled",
      blockers: updateBlockers(this.environment)
    });
  }

  private moveTo(next: UpdateState): UpdateState {
    this.state = next;
    if (!this.destroyed) this.publish(next);
    return next;
  }

  /** The version this build reports, for the idle state. */
  public version(): string {
    return this.currentVersion;
  }
}
