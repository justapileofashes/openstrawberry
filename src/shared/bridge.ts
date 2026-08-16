/**
 * The capability contract between the trusted main process and the untrusted
 * renderer. The preload implements exactly this shape and nothing more.
 *
 * Nothing on this interface may carry raw credentials, browser passwords,
 * session tokens, or absolute local paths.
 */
export interface OpenStrawberryBridge {
  /** Static, non-secret shell information the chrome needs to render itself. */
  readonly shell: {
    readonly platform: string;
  };
}
