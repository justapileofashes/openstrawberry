/**
 * Asking to be the system's default browser.
 *
 * This is a small feature with an unusually large blast radius: it changes what
 * happens when the person clicks a link in their mail client, months from now,
 * long after they have forgotten this button. Three things follow from that.
 *
 *   1. **Only a packaged build may ask.** An unpackaged run would register the
 *      Electron binary and its development arguments as the machine's HTTP
 *      handler, and that registration outlives the session it was made in. A
 *      development build refuses rather than leaving a mess on someone's system.
 *
 *   2. **A refusal is a state, not an error.** `unavailable` carries its reasons
 *      so the panel can say something true about why the button is inert,
 *      exactly as the update channel does.
 *
 *   3. **The platform decides what "asking" means.** macOS and Linux let an
 *      application claim the protocols directly. Windows does not: since
 *      Windows 10 the default browser is the user's choice to make in Settings,
 *      and an application can only register itself as a candidate and take the
 *      person there. `pending` is that outcome - handed off, not done - and it
 *      exists so the chrome never claims a success the OS has not granted.
 *
 * Pure ASCII, and no Electron import, so the whole decision is unit testable.
 */

/**
 * The protocols a browser must own to be the default one.
 *
 * Both, and always together: an app that handles `http` but not `https` is a
 * broken default rather than a partial one.
 */
export const DEFAULT_BROWSER_PROTOCOLS = ["http", "https"] as const;

export type DefaultBrowserProtocol = (typeof DEFAULT_BROWSER_PROTOCOLS)[number];

/**
 * Why the request cannot be made at all.
 *
 * Codes rather than prose, and each names a different fix, so the panel can
 * distinguish "this build will never ask" from "this system has no way to be
 * asked".
 */
export const DEFAULT_BROWSER_BLOCKERS = ["not-packaged", "platform-unsupported"] as const;

export type DefaultBrowserBlocker = (typeof DEFAULT_BROWSER_BLOCKERS)[number];

/**
 * How the operating system lets an application ask.
 *
 * `direct` means the claim itself is the act. `system-settings` means the app
 * may only register as a candidate and open the place where the person chooses.
 */
export type DefaultBrowserMethod = "direct" | "system-settings";

export type DefaultBrowserState =
  /** The only state a build that must not ask can be in. */
  | { readonly status: "unavailable"; readonly blockers: readonly DefaultBrowserBlocker[] }
  | { readonly status: "default" }
  | { readonly status: "not-default"; readonly method: DefaultBrowserMethod }
  /** Registered as a candidate and handed to the OS. The person decides there. */
  | { readonly status: "pending" };

export interface DefaultBrowserEnvironment {
  /** `process.platform`. */
  readonly platform: string;
  /** `app.isPackaged`. A development build never registers itself. */
  readonly packaged: boolean;
}

/**
 * How this platform can be asked, or null if it has no mechanism worth using.
 *
 * Windows is the one that differs, and the difference is the point: reporting
 * `direct` there would let the chrome say "OpenStrawberry is now your default
 * browser" when nothing of the sort has happened yet.
 */
export function defaultBrowserMethod(platform: string): DefaultBrowserMethod | null {
  if (platform === "win32") return "system-settings";
  if (platform === "darwin" || platform === "linux") return "direct";
  return null;
}

/** Every reason the request is unavailable, in the order a person would fix them. */
export function defaultBrowserBlockers(
  environment: DefaultBrowserEnvironment
): readonly DefaultBrowserBlocker[] {
  const blockers: DefaultBrowserBlocker[] = [];

  if (!environment.packaged) blockers.push("not-packaged");
  if (defaultBrowserMethod(environment.platform) === null) blockers.push("platform-unsupported");

  return blockers;
}

export function canRequestDefaultBrowser(environment: DefaultBrowserEnvironment): boolean {
  return defaultBrowserBlockers(environment).length === 0;
}

/**
 * The state to report, given what the OS says about the current registration.
 *
 * `isDefault` is the answer for *every* protocol in the set, decided by the
 * caller, so a half-registered app is reported as not default rather than as
 * default with a caveat nothing renders.
 */
export function defaultBrowserState(
  environment: DefaultBrowserEnvironment,
  isDefault: boolean
): DefaultBrowserState {
  const blockers = defaultBrowserBlockers(environment);
  if (blockers.length > 0) return { status: "unavailable", blockers };
  if (isDefault) return { status: "default" };

  // Non-null: an empty blocker list means the platform has a method.
  const method = defaultBrowserMethod(environment.platform) ?? "direct";
  return { status: "not-default", method };
}

/** Whether a state permits pressing the button. */
export function canPressSetDefault(state: DefaultBrowserState): boolean {
  return state.status === "not-default" || state.status === "pending";
}
