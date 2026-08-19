import { describe, expect, it } from "vitest";
import {
  canPressSetDefault,
  canRequestDefaultBrowser,
  DEFAULT_BROWSER_PROTOCOLS,
  defaultBrowserBlockers,
  defaultBrowserMethod,
  defaultBrowserState,
  WINDOWS_DEFAULT_APPS_URL,
  WINDOWS_REGISTERED_APPLICATION
} from "./default-browser.js";

const PACKAGED = { platform: "darwin", packaged: true } as const;

describe("defaultBrowserMethod", () => {
  it("never claims Windows can be set directly", () => {
    // Since Windows 10 the default browser is the person's choice in Settings.
    // Reporting `direct` here would let the chrome announce a success the OS
    // has not granted.
    expect(defaultBrowserMethod("win32")).toBe("system-settings");
  });

  it("claims the protocols directly where the OS allows it", () => {
    expect(defaultBrowserMethod("darwin")).toBe("direct");
    expect(defaultBrowserMethod("linux")).toBe("direct");
  });

  it("has no mechanism for a platform it does not know", () => {
    expect(defaultBrowserMethod("aix")).toBeNull();
  });
});

describe("defaultBrowserBlockers", () => {
  it("refuses an unpackaged build on every platform", () => {
    // A development run would register the Electron binary and its dev
    // arguments as the machine's HTTP handler, and that outlives the session.
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(defaultBrowserBlockers({ platform, packaged: false })).toContain("not-packaged");
    }
  });

  it("reports every reason at once rather than one refusal at a time", () => {
    expect(defaultBrowserBlockers({ platform: "aix", packaged: false })).toEqual([
      "not-packaged",
      "platform-unsupported"
    ]);
  });

  it("permits the request only when nothing objects", () => {
    expect(canRequestDefaultBrowser(PACKAGED)).toBe(true);
    expect(canRequestDefaultBrowser({ platform: "darwin", packaged: false })).toBe(false);
    expect(canRequestDefaultBrowser({ platform: "aix", packaged: true })).toBe(false);
  });
});

describe("defaultBrowserState", () => {
  it("is unavailable with reasons before it is anything else", () => {
    // Blockers outrank the OS answer: a development build must not report
    // itself as the default even if the installed copy happens to be.
    expect(defaultBrowserState({ platform: "darwin", packaged: false }, true)).toEqual({
      status: "unavailable",
      blockers: ["not-packaged"]
    });
  });

  it("carries the platform's method when the offer is live", () => {
    expect(defaultBrowserState({ platform: "win32", packaged: true }, false)).toEqual({
      status: "not-default",
      method: "system-settings"
    });
  });

  it("says nothing more than 'default' once it is", () => {
    expect(defaultBrowserState(PACKAGED, true)).toEqual({ status: "default" });
  });
});

describe("canPressSetDefault", () => {
  it("keeps the button live while the OS still holds the decision", () => {
    // Windows hands the choice to Settings, and the person can come back
    // without having made it. Pressing again must still be possible.
    expect(canPressSetDefault({ status: "pending" })).toBe(true);
  });

  it("offers nothing to press when there is nothing to ask for", () => {
    expect(canPressSetDefault({ status: "default" })).toBe(false);
    expect(canPressSetDefault({ status: "unavailable", blockers: ["not-packaged"] })).toBe(false);
  });
});

describe("DEFAULT_BROWSER_PROTOCOLS", () => {
  it("covers both schemes, because owning one of them is a broken default", () => {
    expect([...DEFAULT_BROWSER_PROTOCOLS]).toEqual(["http", "https"]);
  });
});

describe("WINDOWS_DEFAULT_APPS_URL", () => {
  it("names the registered application it was built from", () => {
    // `pnpm verify:config` holds that name equal to the one the installer
    // registers. Windows 11 build 26200 ignores the parameter and opens the
    // generic page anyway - see the note on the constant - so this pins the
    // shape of the link, not an outcome that was observed.
    expect(WINDOWS_DEFAULT_APPS_URL).toBe(
      `ms-settings:defaultapps?registeredAppUser=${WINDOWS_REGISTERED_APPLICATION}`
    );
  });

  it("stays a settings link and cannot be read as a web URL", () => {
    // shell.openExternal hands this to the OS. A constant is the whole defence:
    // the request channel takes no arguments, so nothing can steer it.
    expect(WINDOWS_DEFAULT_APPS_URL.startsWith("ms-settings:")).toBe(true);
    expect(WINDOWS_DEFAULT_APPS_URL).not.toMatch(/[\s"'<>]/u);
  });
});
