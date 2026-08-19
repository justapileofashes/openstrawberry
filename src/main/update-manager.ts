/**
 * The update channel's runtime, and the refusal in front of it.
 *
 * Every command here re-asks the gate rather than trusting a decision made at
 * construction. That is deliberate: a manager built once and consulted many
 * times is exactly where a stale "allowed" would sit, and the thing on the other
 * side of it downloads and runs code.
 *
 * Nothing in this file talks to a release server itself. It drives an
 * `UpdateTransport`, which is the only thing that does, and it holds that
 * transport at arm's length: a manager with none refuses rather than crashes,
 * and every value arriving back from one is treated as remote content, because
 * it is. The gate, the state machine, and the refusals live here; fetching lives
 * on the far side of the seam.
 */
import {
  initialUpdateState,
  isUpdateAllowed,
  parsePercent,
  parseVersion,
  updateBlockers,
  canDownload,
  canInstall,
  type UpdateEnvironment,
  type UpdateState
} from "../shared/updates.js";
import type { UpdateFailureCause, UpdateTransport } from "./update-transport.js";

export interface UpdateManagerOptions {
  readonly environment: UpdateEnvironment;
  readonly currentVersion: string;
  readonly publish: (state: UpdateState) => void;
  /**
   * Absent in a build that has not wired one, which is a supported state and
   * not a broken one: every command then refuses with `metadata-invalid`
   * rather than pretending a channel exists.
   */
  readonly transport?: UpdateTransport | null;
}

export class UpdateManager {
  private readonly environment: UpdateEnvironment;
  private readonly currentVersion: string;
  private readonly publish: (state: UpdateState) => void;
  private readonly transport: UpdateTransport | null;

  private state: UpdateState;
  private destroyed = false;

  /**
   * The version the last check reported, kept so that progress and completion
   * events do not have to trust a second remote copy of it. A download reports
   * a percentage; which version it belongs to was established when the update
   * was found.
   */
  private offered: string | null = null;

  public constructor(options: UpdateManagerOptions) {
    this.environment = options.environment;
    this.currentVersion = options.currentVersion;
    this.publish = options.publish;
    this.transport = options.transport ?? null;
    this.state = initialUpdateState(options.environment, options.currentVersion);

    // Subscribed even while the gate is shut. The transport is only ever
    // constructed by a caller that has already checked, and every handler
    // re-asks the gate anyway, so there is no path where a late event moves a
    // disabled build out of `disabled`.
    this.transport?.listen({
      onAvailable: (version) => this.receiveAvailable(version),
      onNotAvailable: () => this.receiveNotAvailable(),
      onProgress: (percent) => this.receiveProgress(percent),
      onDownloaded: (version) => this.receiveDownloaded(version),
      onError: (cause) => this.receiveError(cause)
    });
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
    if (this.transport === null) return this.moveTo({ status: "error", code: "metadata-invalid" });

    const next = this.moveTo({ status: "checking" });
    this.transport.check();
    return next;
  }

  /**
   * Fetches the update the last check found.
   *
   * Refuses unless the state says an update is actually on offer. Asked of the
   * state rather than of a separate flag, so the button in the chrome and the
   * handler here cannot disagree about whether there is anything to fetch.
   */
  public download(): UpdateState {
    if (!this.allowed()) return this.refuse();
    if (this.transport === null) return this.moveTo({ status: "error", code: "metadata-invalid" });
    if (!canDownload(this.state)) return this.state;

    const version = this.offered ?? this.currentVersion;
    const next = this.moveTo({ status: "downloading", version, percent: 0 });
    this.transport.download();
    return next;
  }

  /**
   * Restarts into a downloaded update.
   *
   * Separate from downloading on purpose. An updater that installs what it
   * fetched is one that decides when your work is interrupted.
   */
  public install(): UpdateState {
    if (!this.allowed()) return this.refuse();
    if (this.transport === null) return this.moveTo({ status: "error", code: "metadata-invalid" });
    if (!canInstall(this.state)) return this.state;

    this.transport.install();
    return this.state;
  }

  public destroy(): void {
    this.destroyed = true;
  }

  /* --------------------------------------------------------------------- */
  /* Inbound events                                                        */
  /* --------------------------------------------------------------------- */

  /*
   * Every handler below re-asks the gate first. A transport is an event source
   * that outlives the command that started it, so "the gate was open when the
   * user pressed check" is not the same claim as "the gate is open now", and
   * only the second one may move this state.
   *
   * Every value is parsed rather than read. A version is about to be shown to a
   * person and arrived from a release server; `parseVersion` bounds its length
   * and its alphabet, and a version that fails to parse is a metadata problem,
   * not a version.
   */

  private receiveAvailable(rawVersion: unknown): void {
    if (!this.allowed()) return void this.refuse();

    const version = parseVersion(rawVersion);
    if (version === null) return void this.moveTo({ status: "error", code: "metadata-invalid" });

    this.offered = version;
    this.moveTo({ status: "available", version });
  }

  private receiveNotAvailable(): void {
    if (!this.allowed()) return void this.refuse();

    this.offered = null;
    this.moveTo({ status: "idle", currentVersion: this.currentVersion });
  }

  private receiveProgress(rawPercent: unknown): void {
    if (!this.allowed()) return void this.refuse();
    // Progress for a download this manager did not start says the transport and
    // the state have diverged; the state is the one that decides.
    if (this.state.status !== "downloading") return;

    this.moveTo({
      status: "downloading",
      version: this.state.version,
      percent: parsePercent(rawPercent)
    });
  }

  private receiveDownloaded(rawVersion: unknown): void {
    if (!this.allowed()) return void this.refuse();

    // The version established at check time wins; the event's copy is only a
    // fallback for a transport that reports a download it was never asked for.
    const version = this.offered ?? parseVersion(rawVersion);
    if (version === null) return void this.moveTo({ status: "error", code: "metadata-invalid" });

    this.moveTo({ status: "downloaded", version });
  }

  private receiveError(cause: UpdateFailureCause): void {
    if (!this.allowed()) return void this.refuse();

    // A coarse cause becomes a code the panel has wording for. The server's own
    // message never gets this far - it is logged at the transport and dropped.
    const code =
      cause === "download" ? "download-failed" : cause === "install" ? "install-failed" : "network";

    this.moveTo({ status: "error", code });
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
