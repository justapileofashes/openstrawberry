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
 * Whether published artifacts and update metadata exist for this build to talk
 * to at all.
 *
 * True since v0.1.0-alpha.1: installers are published for all three platforms,
 * with `latest*.yml` beside them, and the update channel resolves against real
 * files rather than a 404.
 *
 * It does **not** mean signed. Those artifacts are an unsigned prerelease, and
 * the signing gate in `docs/RELEASES.md` is still open - which matters most
 * exactly here, because an unsigned update is code fetched from the network and
 * run. What holds in the meantime is transport security and the checksums in
 * the published metadata, and that is a weaker claim than a signature. The two
 * facts are tracked separately on purpose: this constant is about whether there
 * is a channel, `docs/RELEASES.md` is about whether its contents are vouched
 * for, and conflating them is how an unsigned update ships while a boolean
 * claims otherwise.
 */
export const RELEASE_READY = true;

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
export const UPDATE_CHANNEL_ENABLED = true;

export function plannedArtifactName(platform: ReleasePlatform): string {
  return PLANNED_RELEASE_ARTIFACTS[platform];
}
