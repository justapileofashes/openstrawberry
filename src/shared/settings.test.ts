import { describe, expect, it } from "vitest";
import {
  appearanceCssVariables,
  audioReactionActive,
  DEFAULT_APPEARANCE,
  hexToRgbTriplet,
  parseAppearance,
  shineDurationSeconds,
  SHINE_SPEED_MAX_SECONDS,
  SHINE_SPEED_MIN_SECONDS
} from "./settings.js";

describe("parseAppearance", () => {
  it("returns defaults for absent or malformed storage", () => {
    for (const value of [null, undefined, 42, "{}", [], true]) {
      expect(parseAppearance(value)).toEqual(DEFAULT_APPEARANCE);
    }
  });

  it("keeps the shipped look as the default", () => {
    expect(DEFAULT_APPEARANCE.shineEnabled).toBe(true);
    expect(DEFAULT_APPEARANCE.motionEnabled).toBe(true);
    expect(DEFAULT_APPEARANCE.audioReactive).toBe(true);
    // The default shine stays achromatic so the palette rule holds unless a
    // user deliberately opts out of it.
    expect(DEFAULT_APPEARANCE.shineColor).toBe("#dbe6fa");
  });

  it("defaults to a cycle short enough to read as movement", () => {
    // A drift measured in tens of seconds looks like a static highlight.
    expect(shineDurationSeconds(DEFAULT_APPEARANCE.shineSpeed)).toBeLessThanOrEqual(20);
  });

  it("accepts a complete valid payload", () => {
    expect(
      parseAppearance({
        shineEnabled: false,
        shineIntensity: 70,
        shineColor: "#FF8800",
        shineSpeed: 90,
        motionEnabled: false,
        audioReactive: false
      })
    ).toEqual({
      shineEnabled: false,
      shineIntensity: 70,
      shineColor: "#ff8800",
      shineSpeed: 90,
      motionEnabled: false,
      audioReactive: false
    });
  });

  it("keeps settings stored before the audio reaction existed", () => {
    // An existing user's stored payload has no such key, and inheriting the
    // default is what makes the upgrade silent rather than a reset.
    expect(parseAppearance({ shineIntensity: 70 }).audioReactive).toBe(
      DEFAULT_APPEARANCE.audioReactive
    );
    expect(parseAppearance({ audioReactive: "yes" }).audioReactive).toBe(
      DEFAULT_APPEARANCE.audioReactive
    );
  });

  it("clamps out-of-range percentages instead of rejecting them", () => {
    expect(parseAppearance({ shineIntensity: 500 }).shineIntensity).toBe(100);
    expect(parseAppearance({ shineIntensity: -20 }).shineIntensity).toBe(0);
    expect(parseAppearance({ shineSpeed: 42.6 }).shineSpeed).toBe(43);
  });

  it("falls back for a non-numeric or non-finite percentage", () => {
    expect(parseAppearance({ shineIntensity: "70" }).shineIntensity).toBe(
      DEFAULT_APPEARANCE.shineIntensity
    );
    expect(parseAppearance({ shineSpeed: Number.NaN }).shineSpeed).toBe(
      DEFAULT_APPEARANCE.shineSpeed
    );
  });

  it("rejects colours that are not plain six-digit hex", () => {
    for (const color of ["red", "#fff", "#gggggg", "rgb(1,2,3)", "javascript:alert(1)", 16]) {
      expect(parseAppearance({ shineColor: color }).shineColor).toBe(
        DEFAULT_APPEARANCE.shineColor
      );
    }
  });

  it("never lets a stored value inject arbitrary CSS", () => {
    const hostile = parseAppearance({ shineColor: "#fff; background: url(http://evil.test)" });
    expect(hostile.shineColor).toBe(DEFAULT_APPEARANCE.shineColor);
  });
});

describe("hexToRgbTriplet", () => {
  it("converts hex to an rgba-ready triplet", () => {
    expect(hexToRgbTriplet("#dbe6fa")).toBe("219, 230, 250");
    expect(hexToRgbTriplet("#000000")).toBe("0, 0, 0");
    expect(hexToRgbTriplet("#ffffff")).toBe("255, 255, 255");
  });

  it("falls back to the default for invalid input", () => {
    expect(hexToRgbTriplet("nope")).toBe("219, 230, 250");
  });
});

describe("shineDurationSeconds", () => {
  it("inverts the scale so a higher speed means a shorter cycle", () => {
    expect(shineDurationSeconds(0)).toBe(SHINE_SPEED_MAX_SECONDS);
    expect(shineDurationSeconds(100)).toBe(SHINE_SPEED_MIN_SECONDS);
    expect(shineDurationSeconds(50)).toBeLessThan(SHINE_SPEED_MAX_SECONDS);
    expect(shineDurationSeconds(50)).toBeGreaterThan(SHINE_SPEED_MIN_SECONDS);
  });

  it("clamps input outside the percentage range", () => {
    expect(shineDurationSeconds(-50)).toBe(SHINE_SPEED_MAX_SECONDS);
    expect(shineDurationSeconds(500)).toBe(SHINE_SPEED_MIN_SECONDS);
  });
});

describe("appearanceCssVariables", () => {
  it("emits the custom properties the chrome reads", () => {
    // Derived from the defaults rather than hardcoded, so tuning the look does
    // not break a test that is really about the shape of the output.
    expect(appearanceCssVariables(DEFAULT_APPEARANCE)).toEqual({
      "--shine-rgb": "219, 230, 250",
      "--shine-intensity": String(DEFAULT_APPEARANCE.shineIntensity),
      "--shine-duration": `${shineDurationSeconds(DEFAULT_APPEARANCE.shineSpeed)}s`
    });
  });
});

describe("audioReactionActive", () => {
  it("runs on the shipped defaults", () => {
    expect(audioReactionActive(DEFAULT_APPEARANCE, false)).toBe(true);
  });

  it("yields to reduced motion whatever the settings say", () => {
    // Checked here rather than in the capture layer, so the audio device is
    // never opened for a user who has asked the machine to hold still.
    expect(audioReactionActive(DEFAULT_APPEARANCE, true)).toBe(false);
    expect(
      audioReactionActive({ ...DEFAULT_APPEARANCE, audioReactive: true }, true)
    ).toBe(false);
  });

  it("yields to either master switch", () => {
    // The reaction is motion, and it modulates the shine; with either off there
    // is nothing for it to be.
    expect(audioReactionActive({ ...DEFAULT_APPEARANCE, motionEnabled: false }, false)).toBe(
      false
    );
    expect(audioReactionActive({ ...DEFAULT_APPEARANCE, shineEnabled: false }, false)).toBe(
      false
    );
  });

  it("is off when the user turned it off", () => {
    expect(audioReactionActive({ ...DEFAULT_APPEARANCE, audioReactive: false }, false)).toBe(
      false
    );
  });
});
