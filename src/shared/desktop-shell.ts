/**
 * Stable desktop identity and the release artifact names OpenStrawberry intends
 * to publish. These names are documented so packaging and release tooling agree
 * on them, but naming an artifact here does not mean it exists or is signed.
 */

export const APP_ID = "io.openstrawberry.browser";
export const PRODUCT_NAME = "OpenStrawberry";
export const DESKTOP_NAME = "openstrawberry";

/** The persistent, app-owned session partition every guest view renders into. */
export const PROFILE_PARTITION = "persist:openstrawberry-default";

/**
 * The neutral internal page used for first launch, new tabs, and any empty
 * restore slot. This is the only non-HTTP(S) URL the navigation policy allows.
 */
export const BLANK_PAGE = "about:blank";

export type ReleasePlatform =
  | "mac-universal"
  | "win-x64"
  | "linux-appimage"
  | "linux-deb"
  | "linux-rpm";

export const PLANNED_RELEASE_ARTIFACTS: Readonly<Record<ReleasePlatform, string>> = Object.freeze({
  "mac-universal": "OpenStrawberry-mac-universal.dmg",
  "win-x64": "OpenStrawberry-win-x64.exe",
  "linux-appimage": "OpenStrawberry-linux-x86_64.AppImage",
  "linux-deb": "OpenStrawberry-linux-amd64.deb",
  "linux-rpm": "OpenStrawberry-linux-x86_64.rpm"
});

/**
 * OpenStrawberry is work in progress. Public installers are neither stable nor
 * signed, so no build may advertise a download or enable the update channel
 * until signed artifacts and verified update metadata exist.
 */
export const RELEASE_READY = false;

export function plannedArtifactName(platform: ReleasePlatform): string {
  return PLANNED_RELEASE_ARTIFACTS[platform];
}
