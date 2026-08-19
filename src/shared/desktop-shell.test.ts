import { describe, expect, it } from "vitest";
import {
  APP_ID,
  BLANK_PAGE,
  DESKTOP_NAME,
  PLANNED_RELEASE_ARTIFACTS,
  PRODUCT_NAME,
  PROFILE_PARTITION,
  RELEASE_READY,
  plannedArtifactName,
  usesCustomWindowControls
} from "./desktop-shell.js";

describe("desktop identity", () => {
  it("uses the stable native identity", () => {
    expect(APP_ID).toBe("io.openstrawberry.browser");
    expect(PRODUCT_NAME).toBe("OpenStrawberry");
    expect(DESKTOP_NAME).toBe("openstrawberry");
  });

  it("renders guest content in an app-owned persistent partition", () => {
    expect(PROFILE_PARTITION).toBe("persist:openstrawberry-default");
    expect(PROFILE_PARTITION.startsWith("persist:")).toBe(true);
  });

  it("uses a neutral blank start page rather than a live example domain", () => {
    expect(BLANK_PAGE).toBe("about:blank");
  });
});

describe("window controls", () => {
  it("leaves macOS its native traffic lights", () => {
    expect(usesCustomWindowControls("darwin")).toBe(false);
  });

  it("draws its own controls everywhere the title bar is hidden", () => {
    expect(usesCustomWindowControls("win32")).toBe(true);
    expect(usesCustomWindowControls("linux")).toBe(true);
    // An unrecognised platform gets the hidden title bar and the controls that
    // go with it, never a hidden title bar with no way to close the window.
    expect(usesCustomWindowControls("freebsd")).toBe(true);
  });
});

describe("planned release artifacts", () => {
  it("matches the documented per-platform names", () => {
    expect(plannedArtifactName("mac-universal")).toBe("OpenStrawberry-mac-universal.dmg");
    expect(plannedArtifactName("win-x64")).toBe("OpenStrawberry-win-x64.exe");
    expect(plannedArtifactName("linux-appimage")).toBe("OpenStrawberry-linux-x86_64.AppImage");
    expect(plannedArtifactName("linux-deb")).toBe("OpenStrawberry-linux-amd64.deb");
    expect(plannedArtifactName("linux-rpm")).toBe("OpenStrawberry-linux-x86_64.rpm");
  });

  it("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(PLANNED_RELEASE_ARTIFACTS)).toBe(true);
  });

  it("keeps the project marked as not release ready", () => {
    // This guard must only change alongside real signing and verified metadata.
    expect(RELEASE_READY).toBe(false);
  });
});
