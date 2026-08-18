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

/**
 * Whether OpenStrawberry draws its own window controls on this platform.
 *
 * macOS keeps its native traffic lights, which sit inset over the chrome and are
 * what users there expect. Everywhere else the system title bar is hidden and
 * the chrome supplies minimise, maximise, and close itself.
 *
 * Both sides read this one function: the main process to decide the title-bar
 * style, the renderer to decide whether to render the controls. They cannot
 * disagree and leave a window with two sets of buttons, or none.
 */
export function usesCustomWindowControls(platform: string): boolean {
  return platform !== "darwin";
}

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

/**
 * The update channel's own switch, mirroring `openstrawberryUpdateChannel` in
 * `package.json`.
 *
 * Held here as well as there because the gate is a conjunction of three
 * independent facts, and a conjunction is only worth something if its parts are
 * genuinely separate. This one is the maintainer's intent to publish updates at
 * all; `RELEASE_READY` is whether the artifacts justify it; `app.isPackaged` is
 * whether this build could sensibly replace itself.
 */
export const UPDATE_CHANNEL_ENABLED = false;

export function plannedArtifactName(platform: ReleasePlatform): string {
  return PLANNED_RELEASE_ARTIFACTS[platform];
}
