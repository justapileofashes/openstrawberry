import { describe, expect, it } from "vitest";
import {
  buildMediaState,
  emptyMediaState,
  formatMediaTime,
  MAX_MEDIA_DURATION_SECONDS,
  MEDIA_ACTIONS,
  mediaProgress,
  parseMediaCommandPayload,
  parseMediaTabPayload
} from "./media.js";

const RTL_OVERRIDE = "\u202E";

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hasMedia: true,
    playing: true,
    muted: false,
    durationSeconds: 300,
    positionSeconds: 60,
    canPictureInPicture: true,
    title: "A Video",
    ...overrides
  };
}

describe("buildMediaState", () => {
  it("reads a well-formed report", () => {
    const state = buildMediaState(report());

    expect(state.hasMedia).toBe(true);
    expect(state.playing).toBe(true);
    expect(state.durationSeconds).toBe(300);
    expect(state.positionSeconds).toBe(60);
    expect(state.canPictureInPicture).toBe(true);
    expect(state.title).toBe("A Video");
  });

  it("reports no media for anything unreadable", () => {
    // The safe answer: the control simply does not appear.
    for (const hostile of [null, undefined, 42, "text", [], {}, { hasMedia: "yes" }]) {
      expect(buildMediaState(hostile)).toEqual(emptyMediaState());
    }
  });

  it("requires booleans rather than coercing truthy values", () => {
    const state = buildMediaState(report({ playing: 1, muted: "true", canPictureInPicture: {} }));

    expect(state.playing).toBe(false);
    expect(state.muted).toBe(false);
    expect(state.canPictureInPicture).toBe(false);
  });

  it("treats a live stream's Infinity duration as unknown", () => {
    // Carried through, it would render as nonsense.
    const state = buildMediaState(report({ durationSeconds: Number.POSITIVE_INFINITY }));
    expect(state.durationSeconds).toBe(0);
  });

  it("treats a stalled element's NaN as unknown", () => {
    expect(buildMediaState(report({ durationSeconds: Number.NaN })).durationSeconds).toBe(0);
  });

  it("refuses a negative or absurd duration", () => {
    expect(buildMediaState(report({ durationSeconds: -5 })).durationSeconds).toBe(0);
    expect(
      buildMediaState(report({ durationSeconds: MAX_MEDIA_DURATION_SECONDS * 10 })).durationSeconds
    ).toBe(MAX_MEDIA_DURATION_SECONDS);
  });

  it("clamps a position past the duration", () => {
    // A page contradicting itself must not push the bar outside its track.
    const state = buildMediaState(report({ durationSeconds: 100, positionSeconds: 900 }));
    expect(state.positionSeconds).toBe(100);
  });

  it("sanitises a title taken from the page", () => {
    const state = buildMediaState(report({ title: `Video${RTL_OVERRIDE}name` }));
    expect(state.title).toBe("Videoname");
  });

  it("bounds an absurd title", () => {
    const state = buildMediaState(report({ title: "t".repeat(5000) }));
    expect(state.title.length).toBeLessThanOrEqual(200);
  });

  it("carries no field a page could smuggle anything through", () => {
    const state = buildMediaState(report({ src: "https://evil/x", cookie: "secret" }));
    expect(JSON.stringify(state)).not.toContain("evil");
    expect(JSON.stringify(state)).not.toContain("secret");
  });
});

describe("mediaProgress", () => {
  it("measures against the duration", () => {
    expect(mediaProgress(buildMediaState(report({ durationSeconds: 200, positionSeconds: 50 })))).toBe(
      0.25
    );
  });

  it("is null without a duration, so the bar reads as unknown", () => {
    expect(mediaProgress(buildMediaState(report({ durationSeconds: 0 })))).toBeNull();
    expect(mediaProgress(emptyMediaState())).toBeNull();
  });
});

describe("formatMediaTime", () => {
  it("formats minutes and seconds", () => {
    expect(formatMediaTime(0)).toBe("0:00");
    expect(formatMediaTime(9)).toBe("0:09");
    expect(formatMediaTime(75)).toBe("1:15");
    expect(formatMediaTime(600)).toBe("10:00");
  });

  it("adds hours only when there are some", () => {
    expect(formatMediaTime(3661)).toBe("1:01:01");
  });

  it("treats nonsense as zero", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatMediaTime(value)).toBe("0:00");
    }
  });
});

describe("payload validators", () => {
  it("accepts every shipped action", () => {
    for (const action of MEDIA_ACTIONS) {
      expect(parseMediaCommandPayload({ tabId: "tab-1", action })).toEqual({
        tabId: "tab-1",
        action
      });
    }
  });

  it("refuses an action the app does not ship", () => {
    // This is what keeps the surface a control rather than an execution one.
    for (const action of [
      "evaluate",
      "eval",
      "seek",
      "alert(1)",
      "",
      null,
      42,
      ["play"]
    ]) {
      expect(() => parseMediaCommandPayload({ tabId: "tab-1", action })).toThrow();
    }
  });

  it("refuses a malformed tab id", () => {
    for (const hostile of [null, [], "tab-1", { tabId: "" }, { tabId: "../x" }]) {
      expect(() => parseMediaTabPayload(hostile)).toThrow();
    }
  });

  it("accepts a well-formed tab payload", () => {
    expect(parseMediaTabPayload({ tabId: "tab-3" })).toEqual({ tabId: "tab-3" });
  });
});

describe("MEDIA_ACTIONS", () => {
  it("stays a small closed set", () => {
    expect(MEDIA_ACTIONS.length).toBeLessThanOrEqual(8);
    expect(new Set(MEDIA_ACTIONS).size).toBe(MEDIA_ACTIONS.length);
  });
});
