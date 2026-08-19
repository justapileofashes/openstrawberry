/**
 * The seam between the update state machine and whatever actually fetches an
 * update.
 *
 * It exists so that exactly one file imports `electron-updater`, and so the
 * manager that decides *whether* an update may happen never depends on the thing
 * that performs it. Two consequences worth the indirection:
 *
 *   - The gate and the state machine stay testable without Electron. A test can
 *     hand the manager a transport that reports whatever sequence of events it
 *     wants to examine, including ones a real server would be unlikely to
 *     produce.
 *   - There remains a build with no transport at all. `UpdateManager` treats a
 *     missing transport as a refusal rather than a crash, so a build that has
 *     not wired one is honest rather than broken.
 *
 * Everything crossing this boundary inward is remote content: version strings
 * come from a release server, progress numbers come from a download, and error
 * objects carry server text. The manager validates all of it. Nothing here is
 * trusted because it arrived through a typed interface.
 */

/** What the transport reports back, already narrowed to what the state needs. */
export interface UpdateTransportEvents {
  /** A newer version exists. `version` is unvalidated remote text. */
  readonly onAvailable: (version: unknown) => void;
  /** The server answered, and this build is current. */
  readonly onNotAvailable: () => void;
  /** Download progress. `percent` is unvalidated. */
  readonly onProgress: (percent: unknown) => void;
  /** The update is staged on disk and waiting for a restart. */
  readonly onDownloaded: (version: unknown) => void;
  /**
   * Something failed. The transport passes a coarse cause, never the server's
   * own message: that text is remote content and must not reach the chrome.
   */
  readonly onError: (cause: UpdateFailureCause) => void;
}

export type UpdateFailureCause = "check" | "download" | "install";

export interface UpdateTransport {
  /** Subscribes once, before any command is issued. */
  listen(events: UpdateTransportEvents): void;
  /** Asks the server whether anything is newer. Never downloads. */
  check(): void;
  /** Fetches the update the last check found. */
  download(): void;
  /** Quits and installs what was downloaded. Does not return. */
  install(): void;
}

/**
 * The real transport, over `electron-updater`.
 *
 * Constructed only by the main process, and only once the gate has already
 * opened - which is why this file contains no policy of its own. Its whole job
 * is to turn an event-emitting singleton into the interface above, with the two
 * autopilot behaviours switched off:
 *
 *   - `autoDownload = false`, because availability and fetching are separate
 *     acts. Left on, checking for an update downloads it.
 *   - `autoInstallOnAppQuit = false`, because an update that installs itself the
 *     next time you close the window is one that chose the moment for you.
 *
 * The feed is not configured here. electron-builder writes `app-update.yml` into
 * the package from the `publish` block in package.json, and electron-updater
 * reads it. Setting a URL in code as well would create a second place for the
 * channel to be wrong.
 */
export async function createElectronUpdaterTransport(options: {
  readonly allowPrerelease: boolean;
  readonly log: (message: string) => void;
}): Promise<UpdateTransport> {
  // Imported dynamically so that a build which never opens the gate never loads
  // the updater at all.
  const { autoUpdater } = (await import("electron-updater")).default;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = options.allowPrerelease;
  // electron-updater logs the feed URL and every response at info level. That is
  // useful and contains no secret, but it is noise unless something is wrong.
  autoUpdater.logger = null;

  let events: UpdateTransportEvents | null = null;
  /** Which command is outstanding, so a failure can be attributed to it. */
  let pending: UpdateFailureCause = "check";

  return {
    listen(next) {
      events = next;

      autoUpdater.on("update-available", (info) => events?.onAvailable(info?.version));
      autoUpdater.on("update-not-available", () => events?.onNotAvailable());
      autoUpdater.on("download-progress", (progress) => events?.onProgress(progress?.percent));
      autoUpdater.on("update-downloaded", (info) => events?.onDownloaded(info?.version));

      autoUpdater.on("error", (error: unknown) => {
        // Logged locally at the boundary and never forwarded. The user gets a
        // code; whoever is debugging gets the detail, on this machine only.
        options.log(`update ${pending} failed: ${String(error)}`);
        events?.onError(pending);
      });
    },

    check() {
      pending = "check";
      void autoUpdater.checkForUpdates()?.catch(() => events?.onError("check"));
    },

    download() {
      pending = "download";
      void autoUpdater.downloadUpdate()?.catch(() => events?.onError("download"));
    },

    install() {
      pending = "install";
      // isSilent false, isForceRunAfter true: the installer is visible, and the
      // app the person was using comes back.
      autoUpdater.quitAndInstall(false, true);
    }
  };
}
