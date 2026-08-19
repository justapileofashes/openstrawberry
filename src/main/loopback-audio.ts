/**
 * Granting the chrome a loopback tap on the system's own audio output.
 *
 * The visualiser needs to hear what the machine is playing. The obvious route -
 * an `AudioContext` wrapped around the media element inside the page - was
 * rejected: `createMediaElementSource` re-routes an element's audio through the
 * graph it joins, so a suspended context or a page that swaps its element out
 * mid-playback can leave the user staring at a video with no sound. A browser
 * cannot ship a decoration that can mute the web. It also returns silence for
 * exactly the material people play most - anything under EME, and any
 * cross-origin media without CORS - so the failure would have been both common
 * and invisible.
 *
 * Loopback captures the mix after it leaves the page, which reaches DRM content
 * and other applications alike and never touches a page's audio graph at all.
 *
 * What that buys has to be paid for in access control, because a display-media
 * handler is the switch that decides whether *anything* in a session may
 * capture the screen. Three things keep that narrow.
 *
 * **Only the chrome's session has a handler.** Guests render into the profile
 * partition, which is left without one; in Electron a session with no handler
 * refuses `getDisplayMedia` outright, so no page can reach this code path.
 *
 * **Only the trusted WebContents is answered.** The session boundary above is
 * already sufficient, so this is the second lock on the same door: the request
 * is matched against the id bound at window creation, the same id the IPC trust
 * boundary uses.
 *
 * **Video is never granted.** Not narrowed, not downgraded - absent. The
 * callback below has no branch that returns a video source, so the strongest
 * thing this handler can hand back is a microphone-shaped view of the speakers.
 * A screen frame cannot leave through it.
 */
import type { Session } from "electron";

/**
 * Electron implements loopback capture on Windows only.
 *
 * Elsewhere the request is refused and the renderer falls back to reacting to
 * the fact that a tab is audible, which needs no capture at all.
 */
export function platformSupportsLoopback(platform: string): boolean {
  return platform === "win32";
}

/** The part of a display-media request this decision actually rests on. */
export interface LoopbackRequest {
  /** The WebContents behind the requesting frame, or null if unresolvable. */
  readonly webContentsId: number | null;
  readonly audioRequested: boolean;
  readonly videoRequested: boolean;
}

export type LoopbackDecision =
  | { readonly grant: true }
  | { readonly grant: false; readonly reason: string };

/**
 * Whether one request may be answered with a loopback tap.
 *
 * Written as a total function over its inputs so the refusals are enumerable
 * rather than emergent. Every path that is not the single explicit grant is a
 * refusal carrying its reason, which is what makes this reviewable as an access
 * control rule instead of as a chain of guards.
 */
export function loopbackDecision(
  request: LoopbackRequest,
  trustedWebContentsId: number,
  platform: string
): LoopbackDecision {
  if (!platformSupportsLoopback(platform)) {
    return { grant: false, reason: "Loopback capture is unavailable on this platform." };
  }

  if (request.webContentsId === null) {
    // A frame that cannot be resolved back to a WebContents cannot be shown to
    // be the trusted one, and unproven is refused.
    return { grant: false, reason: "The requesting frame could not be identified." };
  }

  if (request.webContentsId !== trustedWebContentsId) {
    return { grant: false, reason: "Only the application chrome may capture audio." };
  }

  if (!request.audioRequested) {
    // The only thing on offer is audio. A request that did not ask for it is
    // asking for video, which this handler exists never to give.
    return { grant: false, reason: "Only audio capture is offered." };
  }

  if (request.videoRequested) {
    /*
     * Refused rather than partly answered. Electron rejects a display-media
     * request whose video half went unsatisfied, so handing back audio here
     * would produce a stream the renderer never receives - and would do it by
     * throwing out of the callback. The chrome asks for audio alone, so this
     * branch is unreachable in practice and exists to keep it that way.
     */
    return { grant: false, reason: "Video capture is never granted." };
  }

  return { grant: true };
}

/* -------------------------------------------------------------------------- */
/* Permissions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a permission decision rests on.
 *
 * `mediaTypes` is the discriminator that matters. Chromium routes screen and
 * audio capture through the same `media` permission that the microphone and
 * camera use, and the only thing separating them at this layer is that display
 * capture arrives with an empty list where `getUserMedia` names what it wants.
 */
export interface PermissionQuery {
  readonly contentsId: number | null | undefined;
  readonly permission: string;
  readonly mediaTypes?: readonly string[] | undefined;
}

/**
 * Whether a permission *request* from the chrome's session may be granted.
 *
 * This is the gate that actually authorises capture, and it is deliberately
 * narrower than the permission Chromium asks for. `media` with a named type is
 * a microphone or camera request and is refused; `media` with no named type is
 * the display-capture shape, which the display-media handler then answers with
 * loopback audio and nothing else.
 */
export function allowPermissionRequest(
  query: PermissionQuery,
  trustedWebContentsId: number,
  platform: string
): boolean {
  if (!platformSupportsLoopback(platform)) return false;
  if (query.contentsId !== trustedWebContentsId) return false;
  if (query.permission !== "media") return false;

  const types = query.mediaTypes;
  return Array.isArray(types) && types.length === 0;
}

/**
 * Permissions the chrome may be found to already hold.
 *
 * Chromium consults this several times while setting a capture up, including
 * once for the output device. It is broader than the request gate above by
 * necessity - the checks do not carry the `mediaTypes` discriminator - which is
 * why the request gate is where the real decision lives: nothing reaches a
 * capture without passing through it first.
 */
export function allowPermissionCheck(
  query: PermissionQuery,
  trustedWebContentsId: number,
  platform: string
): boolean {
  if (!platformSupportsLoopback(platform)) return false;
  if (query.contentsId !== trustedWebContentsId) return false;
  return query.permission === "media" || query.permission === "speaker-selection";
}

/* -------------------------------------------------------------------------- */
/* Installation                                                                */
/* -------------------------------------------------------------------------- */

export interface LoopbackAudioOptions {
  /** The chrome's own session. Never a guest partition. */
  readonly session: Session;
  /** The WebContents id bound as trusted at window creation. */
  readonly trustedWebContentsId: number;
  readonly platform: string;
  /**
   * Resolves the WebContents behind a requesting frame.
   *
   * Injected rather than imported so this module holds no Electron runtime
   * import, which is what lets the decision above be tested directly.
   */
  readonly webContentsIdForFrame: (frame: unknown) => number | null;
}

/** Reads `mediaTypes` off a permission detail bag that may not carry one. */
function mediaTypesOf(details: unknown): readonly string[] | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as Record<string, unknown>)["mediaTypes"];
  return Array.isArray(value) ? (value as readonly string[]) : undefined;
}

/**
 * Installs the handler on the chrome's session.
 *
 * This restates the blanket denial that session was given at startup rather
 * than leaving it in place, because leaving it would have Chromium refuse the
 * capture before the display-media handler below ever ran. What replaces it is
 * narrower than it looks: on Windows, from the one trusted WebContents, a
 * `media` request that names no media type - which is the shape display capture
 * arrives in and not the shape a microphone request does. Everything else, from
 * everyone, is refused exactly as before, and the guest partition keeps its own
 * blanket denial untouched.
 */
export function installLoopbackAudio(options: LoopbackAudioOptions): void {
  const { session, trustedWebContentsId, platform, webContentsIdForFrame } = options;

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(
      allowPermissionRequest(
        {
          contentsId: contents?.id,
          permission: String(permission),
          mediaTypes: mediaTypesOf(details)
        },
        trustedWebContentsId,
        platform
      )
    );
  });

  session.setPermissionCheckHandler((contents, permission) =>
    allowPermissionCheck(
      { contentsId: contents?.id, permission: String(permission) },
      trustedWebContentsId,
      platform
    )
  );

  session.setDisplayMediaRequestHandler(
    (request, callback) => {
      const decision = loopbackDecision(
        {
          webContentsId: webContentsIdForFrame(request.frame),
          audioRequested: request.audioRequested,
          videoRequested: request.videoRequested
        },
        trustedWebContentsId,
        platform
      );

      /*
       * Wrapped because `callback` throws, synchronously and out of here, when
       * a request asked for video that no stream set can satisfy - and it does
       * so for the empty set that means "denied" just as readily as for a
       * partial grant. Catching it at the point it is raised is what keeps a
       * refusal from surfacing as an unhandled rejection in the trusted
       * process. The renderer sees the rejection it should either way.
       */
      try {
        /*
         * An empty stream set is Electron's spelling of "denied". The renderer
         * treats that identically to a platform without loopback: it drops to
         * the fallback and says nothing, because a user who never asked for a
         * visualiser should not be told one failed.
         */
        if (!decision.grant) {
          callback({});
          return;
        }

        // Audio only, and with no `video` key at all - see the note at the top
        // of this file about what this handler cannot hand back.
        callback({ audio: "loopback" });
      } catch {
        // Already a refusal by the time it lands here; nothing to add.
      }
    },
    // The system picker is a screen-sharing chooser. There is nothing here for
    // a user to choose between, and showing one would misdescribe what this is.
    { useSystemPicker: false }
  );
}
