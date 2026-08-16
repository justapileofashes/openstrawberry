/**
 * Sender verification for renderer-reachable IPC.
 *
 * Payload validation answers "is this well formed?". This module answers the
 * prior question: "did this actually come from our chrome?".
 *
 * Guest web content runs in the same application and can reach ipcRenderer only
 * if a preload exposes it, but the trusted process must not depend on that. A
 * channel is served only when the sender is the top-level frame of the exact
 * WebContents that hosts OpenStrawberry's own chrome.
 *
 * The checks are pure functions over a minimal event shape so they can be unit
 * tested without booting Electron.
 */

export class IpcSecurityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IpcSecurityError";
  }
}

/** The minimal projection of an Electron IPC event these checks need. */
export interface IncomingIpcEvent {
  /** `event.sender.id` — the WebContents that emitted the message. */
  readonly senderWebContentsId: number;
  /** `event.senderFrame?.url` — null when the frame is already gone. */
  readonly senderFrameUrl: string | null;
  /** Whether the sending frame is the top-level frame, not an embedded one. */
  readonly senderIsMainFrame: boolean;
}

export interface TrustedRendererPolicy {
  /** The WebContents id of the window hosting OpenStrawberry's chrome. */
  readonly trustedWebContentsId: number;
  /**
   * URL prefixes the chrome itself is served from: the packaged `file:` bundle,
   * or the loopback dev server. Never a remote origin.
   */
  readonly allowedUrlPrefixes: readonly string[];
}

export function isTrustedSender(
  event: IncomingIpcEvent,
  policy: TrustedRendererPolicy
): boolean {
  if (event.senderWebContentsId !== policy.trustedWebContentsId) return false;

  // A subframe must never drive privileged operations, even inside our own
  // WebContents.
  if (!event.senderIsMainFrame) return false;

  const url = event.senderFrameUrl;
  if (url === null || url.length === 0) return false;

  return policy.allowedUrlPrefixes.some((prefix) => url.startsWith(prefix));
}

/** Throws unless the event came from the trusted chrome renderer. */
export function assertTrustedSender(
  event: IncomingIpcEvent,
  policy: TrustedRendererPolicy,
  channel: string
): void {
  if (!isTrustedSender(event, policy)) {
    // The rejected URL is deliberately not included; it is attacker-controlled.
    throw new IpcSecurityError(`Rejected untrusted IPC sender on channel ${channel}.`);
  }
}

/**
 * Converts a main-process failure into something safe to hand back over IPC.
 *
 * Main-process errors routinely carry absolute local paths, and could carry
 * provider responses or credential material. None of that may cross into the
 * renderer, so only errors this module deliberately authored are passed
 * through; everything else collapses to a generic message and is logged in the
 * trusted process instead.
 */
export function redactErrorForRenderer(error: unknown): string {
  if (error instanceof IpcSecurityError) return error.message;

  // Validation errors name a field and an expectation, never a rejected value.
  if (error instanceof Error && error.name === "IpcValidationError") return error.message;

  return "The request could not be completed.";
}

/**
 * Builds the allowlist of URL prefixes the chrome may be served from.
 *
 * In development the renderer is served by the loopback Vite server. In a
 * packaged build it is loaded from disk over `file:`. Nothing else qualifies,
 * and a remote origin is never accepted in either mode.
 */
export function buildAllowedUrlPrefixes(devServerUrl: string | undefined): readonly string[] {
  const prefixes = ["file://"];

  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(devServerUrl);
    } catch {
      return prefixes;
    }

    const isLoopback =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";

    if (parsed.protocol === "http:" && isLoopback) prefixes.push(parsed.origin);
  }

  return prefixes;
}
