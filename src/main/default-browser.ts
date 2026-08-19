/**
 * The Electron adapter for the default-browser request.
 *
 * The decision itself lives in `../shared/default-browser.js` as pure
 * functions; this file only supplies what Electron knows - whether the build is
 * packaged, and whether the OS currently points the web at us - and performs
 * the one side effect the feature has.
 */
import { app, shell } from "electron";
import {
  DEFAULT_BROWSER_PROTOCOLS,
  WINDOWS_DEFAULT_APPS_URL,
  canRequestDefaultBrowser,
  defaultBrowserMethod,
  defaultBrowserBlockers,
  defaultBrowserState,
  type DefaultBrowserEnvironment,
  type DefaultBrowserState
} from "../shared/default-browser.js";

function environment(): DefaultBrowserEnvironment {
  return { platform: process.platform, packaged: app.isPackaged };
}

/** True only when the OS points *every* web protocol at this application. */
function ownsEveryProtocol(): boolean {
  return DEFAULT_BROWSER_PROTOCOLS.every((protocol) => app.isDefaultProtocolClient(protocol));
}

export function readDefaultBrowserState(): DefaultBrowserState {
  const current = environment();
  // Asking the OS is skipped entirely when the answer could not be acted on,
  // which also keeps a development build from touching the registration at all.
  if (!canRequestDefaultBrowser(current)) return defaultBrowserState(current, false);
  return defaultBrowserState(current, ownsEveryProtocol());
}

/**
 * Asks to become the default browser.
 *
 * On macOS and Linux the claim is the act, and the returned state is whatever
 * the OS says afterwards rather than whatever the call returned - the two can
 * differ, and only the former is worth reporting.
 *
 * On Windows the claim registers this application as a candidate and the person
 * finishes in Settings, so the result is `pending`. Announcing success there
 * would be a lie the user discovers the next time they click a link.
 */
export async function requestDefaultBrowser(): Promise<DefaultBrowserState> {
  const current = environment();
  const blockers = defaultBrowserBlockers(current);
  if (blockers.length > 0) return { status: "unavailable", blockers };

  for (const protocol of DEFAULT_BROWSER_PROTOCOLS) {
    app.setAsDefaultProtocolClient(protocol);
  }

  if (defaultBrowserMethod(current.platform) === "system-settings") {
    await shell.openExternal(WINDOWS_DEFAULT_APPS_URL);
    return { status: "pending" };
  }

  return defaultBrowserState(current, ownsEveryProtocol());
}
