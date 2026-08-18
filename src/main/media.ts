/**
 * Reading and driving media in a guest page.
 *
 * The same discipline as reader mode: the scripts below run inside a page that
 * can redefine anything they touch, so what comes back is untrusted JSON and
 * `buildMediaState` re-derives every field.
 *
 * The part that is different, and load-bearing, is the direction of travel. The
 * renderer sends an action identifier from a closed set; this module holds the
 * scripts and picks one by that identifier. No string the renderer supplies is
 * ever evaluated in a page. `ACTION_SCRIPTS` being a fixed record keyed by a
 * validated union is the whole of that guarantee - there is no default branch,
 * no template interpolation, and no way to reach `executeJavaScript` with
 * anything but one of these constants.
 */
import {
  buildMediaState,
  emptyMediaState,
  type MediaAction,
  type MediaState
} from "../shared/media.js";

/** The slice of a WebContents this module needs. */
export interface MediaContentsPort {
  readonly executeJavaScript: (code: string) => Promise<unknown>;
}

/**
 * Finds the media element worth controlling.
 *
 * The largest playing element, falling back to the largest element at all. A
 * page often holds several - an autoplaying advert, a background loop, the video
 * the user came for - and area is a reliable proxy for which one that is.
 *
 * Shared by every script below so they all act on the same element; picking
 * differently per call would pause one thing and report another.
 */
const FIND_MEDIA = `
  const all = Array.from(document.querySelectorAll("video, audio"));
  const usable = all.filter((element) => {
    if (element.readyState === 0 && element.paused) return false;
    return true;
  });
  const area = (element) => (element.clientWidth || 0) * (element.clientHeight || 0);
  const playing = usable.filter((element) => !element.paused);
  const pool = playing.length > 0 ? playing : usable;
  const media = pool.sort((a, b) => area(b) - area(a))[0] || null;
`;

const QUERY_SCRIPT = `(() => {
  try {
    ${FIND_MEDIA}
    if (media === null) return { hasMedia: false };

    return {
      hasMedia: true,
      playing: !media.paused && !media.ended,
      muted: media.muted === true || media.volume === 0,
      durationSeconds: media.duration,
      positionSeconds: media.currentTime,
      canPictureInPicture:
        media.tagName === "VIDEO" &&
        document.pictureInPictureEnabled === true &&
        media.disablePictureInPicture !== true,
      title: (document.title || "").trim()
    };
  } catch {
    return { hasMedia: false };
  }
})()`;

/**
 * One script per action, held here and selected by a validated identifier.
 *
 * Each is something the user could do through the page's own controls, so
 * offering it in the chrome grants no capability the page did not already give
 * them.
 */
const ACTION_SCRIPTS: Readonly<Record<MediaAction, string>> = {
  play: `(() => { try { ${FIND_MEDIA} if (media) { media.play(); } } catch {} })()`,
  pause: `(() => { try { ${FIND_MEDIA} if (media) { media.pause(); } } catch {} })()`,
  mute: `(() => { try { ${FIND_MEDIA} if (media) { media.muted = true; } } catch {} })()`,
  unmute: `(() => { try { ${FIND_MEDIA} if (media) { media.muted = false; } } catch {} })()`,
  /*
   * Picture-in-picture is requested rather than forced. Browsers require a user
   * gesture and may refuse; a refusal is not an error worth surfacing, because
   * the video carries on playing exactly as it was.
   */
  "picture-in-picture": `(() => {
    try {
      ${FIND_MEDIA}
      if (media === null || media.tagName !== "VIDEO") return;
      if (document.pictureInPictureElement !== null) {
        document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled === true) {
        media.requestPictureInPicture();
      }
    } catch {}
  })()`
};

/**
 * Reads the media state of a page.
 *
 * Never throws. A page with no media, a page that threw, and a page that
 * navigated mid-query are all the same ordinary answer: no controls.
 */
export async function readMediaState(contents: MediaContentsPort): Promise<MediaState> {
  let raw: unknown;

  try {
    raw = await contents.executeJavaScript(QUERY_SCRIPT);
  } catch {
    return emptyMediaState();
  }

  try {
    return buildMediaState(raw);
  } catch {
    // Same reasoning as reader mode: the serialisation that makes a throwing
    // getter impossible in practice is Electron's behaviour, not this module's
    // guarantee.
    return emptyMediaState();
  }
}

/**
 * Performs one action, then reports the resulting state.
 *
 * Returning fresh state rather than nothing means the control reflects what
 * actually happened - including a page that refused, which reports the state it
 * still has rather than the one the chrome asked for.
 */
export async function runMediaAction(
  contents: MediaContentsPort,
  action: MediaAction
): Promise<MediaState> {
  try {
    await contents.executeJavaScript(ACTION_SCRIPTS[action]);
  } catch {
    // A page that refuses is not an error; the state read below tells the truth.
  }

  return readMediaState(contents);
}
