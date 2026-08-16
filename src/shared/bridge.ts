/**
 * The capability contract between the trusted main process and the untrusted
 * renderer. The preload implements exactly this shape and nothing more.
 *
 * Nothing on this interface may carry raw credentials, browser passwords,
 * session tokens, or absolute local paths.
 */

/** Channel names, shared so both sides of the boundary cannot drift apart. */
export const IPC_CHANNELS = {
  shellInfo: "shell:info"
} as const;

/** Non-secret facts about the running application. */
export interface ShellInfo {
  readonly platform: string;
  readonly appVersion: string;
  /**
   * False until signed artifacts and verified update metadata exist. The chrome
   * uses this to keep download affordances and the update channel inert.
   */
  readonly releaseReady: boolean;
  readonly updatesEnabled: boolean;
}

export interface OpenStrawberryBridge {
  readonly shell: {
    /** Available synchronously so first paint does not wait on IPC. */
    readonly platform: string;
    readonly getInfo: () => Promise<ShellInfo>;
  };
}
