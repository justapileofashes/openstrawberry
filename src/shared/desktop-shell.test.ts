import { describe, expect, it } from "vitest";
import { DESKTOP_APP_ID, DESKTOP_APP_NAME, RELEASE_ASSETS, latestReleaseDownloadUrl } from "./desktop-shell.js";

describe("desktop shell identity", () => {
  it("uses the stable native application identity", () => {
    expect(DESKTOP_APP_NAME).toBe("OpenStrawberry");
    expect(DESKTOP_APP_ID).toBe("io.openstrawberry.browser");
  });

  it("uses stable asset names for latest-release download buttons", () => {
    expect(RELEASE_ASSETS.macos).toBe("OpenStrawberry-mac-universal.dmg");
    expect(RELEASE_ASSETS.windows).toBe("OpenStrawberry-win-x64.exe");
    expect(latestReleaseDownloadUrl(RELEASE_ASSETS.windows)).toBe(
      "https://github.com/justapileofashes/openstrawberry/releases/latest/download/OpenStrawberry-win-x64.exe",
    );
  });
});
