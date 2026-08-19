import { describe, expect, it } from "vitest";
import {
  allowPermissionCheck,
  allowPermissionRequest,
  loopbackDecision,
  platformSupportsLoopback,
  type LoopbackRequest,
  type PermissionQuery
} from "./loopback-audio.js";

const TRUSTED = 7;

function request(overrides: Partial<LoopbackRequest> = {}): LoopbackRequest {
  return { webContentsId: TRUSTED, audioRequested: true, videoRequested: false, ...overrides };
}

/** The shape Chromium sends for display capture: `media`, naming no type. */
function captureQuery(overrides: Partial<PermissionQuery> = {}): PermissionQuery {
  return { contentsId: TRUSTED, permission: "media", mediaTypes: [], ...overrides };
}

describe("platformSupportsLoopback", () => {
  it("is Windows only", () => {
    expect(platformSupportsLoopback("win32")).toBe(true);
    for (const platform of ["darwin", "linux", "freebsd", "", "WIN32"]) {
      expect(platformSupportsLoopback(platform)).toBe(false);
    }
  });
});

describe("loopbackDecision", () => {
  it("grants the trusted chrome an audio tap on Windows", () => {
    expect(loopbackDecision(request(), TRUSTED, "win32")).toEqual({ grant: true });
  });

  it("refuses a guest page", () => {
    // The session boundary already stops this; the id check is the second lock
    // on the same door.
    const decision = loopbackDecision(request({ webContentsId: 42 }), TRUSTED, "win32");
    expect(decision.grant).toBe(false);
  });

  it("refuses a frame it cannot identify", () => {
    // Unproven is refused: a frame that cannot be resolved back to a
    // WebContents cannot be shown to be the trusted one.
    const decision = loopbackDecision(request({ webContentsId: null }), TRUSTED, "win32");
    expect(decision.grant).toBe(false);
  });

  it("refuses a request that did not ask for audio", () => {
    // Audio is the only thing on offer, so a request without it is asking for
    // video, which this handler exists never to give.
    const decision = loopbackDecision(request({ audioRequested: false }), TRUSTED, "win32");
    expect(decision.grant).toBe(false);
  });

  it("refuses a request that also asked for video", () => {
    /*
     * Verified against Electron 43: answering such a request with audio alone
     * makes `callback` throw "Video was requested, but no video stream was
     * provided", and the renderer's promise rejects regardless. Refusing is the
     * honest form of the same outcome.
     */
    const decision = loopbackDecision(request({ videoRequested: true }), TRUSTED, "win32");
    expect(decision.grant).toBe(false);
  });

  it("refuses every platform without loopback support", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(loopbackDecision(request(), TRUSTED, platform).grant).toBe(false);
    }
  });

  it("refuses a guest even on a supported platform with audio requested", () => {
    // The combination that would be granted for the chrome must still fail on
    // identity alone.
    expect(loopbackDecision(request({ webContentsId: 0 }), TRUSTED, "win32").grant).toBe(false);
  });

  it("explains every refusal", () => {
    const refusals = [
      loopbackDecision(request(), TRUSTED, "darwin"),
      loopbackDecision(request({ webContentsId: null }), TRUSTED, "win32"),
      loopbackDecision(request({ webContentsId: 42 }), TRUSTED, "win32"),
      loopbackDecision(request({ audioRequested: false }), TRUSTED, "win32"),
      loopbackDecision(request({ videoRequested: true }), TRUSTED, "win32")
    ];

    for (const decision of refusals) {
      expect(decision.grant).toBe(false);
      if (!decision.grant) expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("grants on identity rather than on absence of a reason to refuse", () => {
    // Guarding against a future edit that reorders the checks into a default
    // grant: across every combination, only the fully specified one is true.
    let granted = 0;

    for (const webContentsId of [null, 42, TRUSTED]) {
      for (const audioRequested of [false, true]) {
        for (const videoRequested of [false, true]) {
          const decision = loopbackDecision(
            { webContentsId, audioRequested, videoRequested },
            TRUSTED,
            "win32"
          );
          if (decision.grant) granted += 1;
        }
      }
    }

    expect(granted).toBe(1);
  });
});

describe("allowPermissionRequest", () => {
  it("grants the display-capture shape to the trusted chrome", () => {
    // `media` naming no media type. Verified against Electron 43: this is the
    // permission Chromium actually asks for before a display-media request.
    expect(allowPermissionRequest(captureQuery(), TRUSTED, "win32")).toBe(true);
  });

  it("refuses a microphone or camera request", () => {
    /*
     * The whole point of the `mediaTypes` discriminator. Chromium routes screen
     * capture through the same permission `getUserMedia` uses, and a named type
     * is what tells them apart - so the chrome may tap the speakers and still
     * cannot open the microphone.
     */
    for (const types of [["audio"], ["video"], ["audio", "video"]]) {
      expect(allowPermissionRequest(captureQuery({ mediaTypes: types }), TRUSTED, "win32")).toBe(
        false
      );
    }
  });

  it("refuses when the detail bag carried no media types at all", () => {
    // Absent is not the same as empty: an empty list is a positive statement
    // that nothing was named, and only that earns the grant.
    expect(
      allowPermissionRequest(captureQuery({ mediaTypes: undefined }), TRUSTED, "win32")
    ).toBe(false);
  });

  it("refuses every other permission", () => {
    for (const permission of [
      "geolocation",
      "notifications",
      "display-capture",
      "midi",
      "openExternal",
      "web-app-installation"
    ]) {
      expect(allowPermissionRequest(captureQuery({ permission }), TRUSTED, "win32")).toBe(false);
    }
  });

  it("refuses anyone but the trusted chrome", () => {
    for (const contentsId of [42, 0, null, undefined]) {
      expect(allowPermissionRequest(captureQuery({ contentsId }), TRUSTED, "win32")).toBe(false);
    }
  });

  it("grants nothing at all where loopback does not exist", () => {
    // The blanket denial the session started with is preserved intact on every
    // platform that cannot do this.
    for (const platform of ["darwin", "linux"]) {
      expect(allowPermissionRequest(captureQuery(), TRUSTED, platform)).toBe(false);
    }
  });
});

describe("allowPermissionCheck", () => {
  it("grants the checks a capture makes on the way up", () => {
    // Observed on Electron 43: `media` several times, then the output device.
    expect(allowPermissionCheck(captureQuery(), TRUSTED, "win32")).toBe(true);
    expect(
      allowPermissionCheck(captureQuery({ permission: "speaker-selection" }), TRUSTED, "win32")
    ).toBe(true);
  });

  it("refuses everything else, and everyone else", () => {
    for (const permission of ["geolocation", "notifications", "midi", "web-app-installation"]) {
      expect(allowPermissionCheck(captureQuery({ permission }), TRUSTED, "win32")).toBe(false);
    }
    expect(allowPermissionCheck(captureQuery({ contentsId: 42 }), TRUSTED, "win32")).toBe(false);
    expect(allowPermissionCheck(captureQuery(), TRUSTED, "linux")).toBe(false);
  });
});
