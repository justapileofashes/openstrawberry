import { describe, expect, it } from "vitest";
import {
  bandAverage,
  binForHz,
  clamp01,
  decayPeak,
  fallbackReaction,
  FALLBACK_BREATH_MS,
  FALLBACK_GAIN,
  FALLBACK_SPEED,
  followValue,
  MAX_GAIN,
  MAX_PUNCH,
  MAX_SPEED,
  MIN_PEAK,
  normalizeAgainstPeak,
  reactionCssVariables,
  reactionFor,
  RESTING_REACTION,
  shapeLevel,
  SILENCE_FLOOR
} from "./audio-reactive.js";

describe("clamp01", () => {
  it("bounds the unit range and refuses non-numbers", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("followValue", () => {
  it("moves toward the target without overshooting it", () => {
    const next = followValue(0, 1, 16, 40, 260);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1);
  });

  it("rises faster than it falls", () => {
    const rise = followValue(0, 1, 16, 40, 260) - 0;
    const fall = 1 - followValue(1, 0, 16, 40, 260);
    expect(rise).toBeGreaterThan(fall);
  });

  it("gives the same envelope regardless of frame rate", () => {
    // Two 8ms steps must land where one 16ms step does, or the shine would be
    // springier on a 120Hz display than on a 60Hz one.
    const single = followValue(0, 1, 16, 40, 260);
    const halved = followValue(followValue(0, 1, 8, 40, 260), 1, 8, 40, 260);
    expect(halved).toBeCloseTo(single, 5);
  });

  it("clamps a huge delta so a backgrounded window cannot snap", () => {
    // A tab hidden for a minute hands back one enormous delta on its first
    // frame; without the clamp that frame would be a visible jump.
    const huge = followValue(0, 1, 60_000, 40, 260);
    const clamped = followValue(0, 1, 250, 40, 260);
    expect(huge).toBeCloseTo(clamped, 10);
  });

  it("holds still for a zero or negative delta", () => {
    expect(followValue(0.4, 1, 0, 40, 260)).toBe(0.4);
    expect(followValue(0.4, 1, -5, 40, 260)).toBe(0.4);
  });

  it("survives non-finite state rather than propagating it", () => {
    expect(followValue(Number.NaN, 0.5, 16, 40, 260)).toBe(0.5);
    expect(followValue(0.5, Number.NaN, 16, 40, 260)).toBe(0.5);
  });
});

describe("decayPeak", () => {
  it("takes a louder level immediately", () => {
    expect(decayPeak(0.3, 0.9, 16)).toBe(0.9);
  });

  it("falls by half over the half-life", () => {
    // Stepped at a frame's worth at a time, because a single 2600ms call would
    // hit the same stall clamp `followValue` uses. Starting well above the
    // floor so the floor is not what is being measured.
    let peak = 0.8;
    for (let elapsed = 0; elapsed < 2600; elapsed += 16) peak = decayPeak(peak, 0, 16);
    expect(peak).toBeCloseTo(0.4, 2);
  });

  it("never falls below the minimum divisor", () => {
    // This is what stops a fade-out from ending in a blaze.
    let peak = 0.9;
    for (let elapsed = 0; elapsed < 60_000; elapsed += 100) peak = decayPeak(peak, 0, 100);
    expect(peak).toBe(MIN_PEAK);
  });

  it("clamps a stall so a hidden window cannot collapse the divisor", () => {
    expect(decayPeak(0.8, 0, 600_000)).toBeCloseTo(decayPeak(0.8, 0, 250), 10);
  });

  it("treats unusable input as the floor rather than throwing", () => {
    expect(decayPeak(Number.NaN, 0, 16)).toBe(MIN_PEAK);
    expect(decayPeak(0.5, 0, Number.NaN)).toBe(0.5);
  });
});

describe("normalizeAgainstPeak", () => {
  it("reports silence as nothing at all", () => {
    expect(normalizeAgainstPeak(0, 0.8)).toBe(0);
    expect(normalizeAgainstPeak(SILENCE_FLOOR, 0.8)).toBe(0);
    expect(normalizeAgainstPeak(SILENCE_FLOOR - 0.001, 0.8)).toBe(0);
  });

  it("reads the same at the top whatever the volume knob is set to", () => {
    // The point of adaptive gain: quiet music and loud music both fill the
    // range, because the absolute level says more about the mixer than the mix.
    expect(normalizeAgainstPeak(0.9, 0.9)).toBeCloseTo(1, 5);
    expect(normalizeAgainstPeak(0.3, 0.3)).toBeCloseTo(1, 5);
  });

  it("keeps a half-peak level below a full-peak one", () => {
    expect(normalizeAgainstPeak(0.45, 0.9)).toBeLessThan(normalizeAgainstPeak(0.9, 0.9));
  });

  it("stays inside the unit range for contradictory input", () => {
    expect(normalizeAgainstPeak(2, 0.4)).toBe(1);
    expect(normalizeAgainstPeak(Number.NaN, 0.4)).toBe(0);
  });
});

describe("binForHz", () => {
  it("maps a frequency to its bin", () => {
    // 48kHz over a 2048-point FFT is 23.4Hz per bin, so 100Hz lands on bin 4.
    expect(binForHz(100, 48_000, 2048)).toBe(4);
    expect(binForHz(0, 48_000, 2048)).toBe(0);
  });

  it("never points past the last bin", () => {
    expect(binForHz(200_000, 48_000, 2048)).toBe(1023);
  });

  it("answers zero for a device reporting nonsense", () => {
    // The sample rate comes from whatever output device is attached, so an
    // absurd one should cost a dull shine rather than an exception mid-frame.
    expect(binForHz(100, 0, 2048)).toBe(0);
    expect(binForHz(100, Number.NaN, 2048)).toBe(0);
    expect(binForHz(100, 48_000, 0)).toBe(0);
  });
});

describe("bandAverage", () => {
  it("averages a range as a fraction of full scale", () => {
    expect(bandAverage([255, 255, 255, 0], 0, 2)).toBeCloseTo(1, 5);
    expect(bandAverage([0, 0, 0], 0, 2)).toBe(0);
    expect(bandAverage([255, 0], 0, 1)).toBeCloseTo(0.5, 2);
  });

  it("reads a single bin when the bounds meet", () => {
    expect(bandAverage([0, 255, 0], 1, 1)).toBeCloseTo(1, 5);
  });

  it("tolerates reversed and out-of-range bounds", () => {
    // Bounds are derived from a sample rate the caller did not choose.
    expect(bandAverage([255, 255], 1, 0)).toBeCloseTo(1, 5);
    expect(bandAverage([255, 255], 0, 99)).toBeCloseTo(1, 5);
    expect(bandAverage([], 0, 4)).toBe(0);
  });

  it("treats a hole in the data as quiet rather than as NaN", () => {
    expect(bandAverage([255, Number.NaN], 0, 1)).toBeCloseTo(0.5, 2);
  });
});

describe("reactionFor", () => {
  it("rests at exactly the configured appearance", () => {
    // Silence must reproduce the user's own settings untouched, which is what
    // multipliers of 1 mean.
    expect(reactionFor(0, 0)).toEqual(RESTING_REACTION);
  });

  it("tops out at the restrained ceilings", () => {
    expect(reactionFor(1, 1)).toEqual({ speed: MAX_SPEED, gain: MAX_GAIN, punch: MAX_PUNCH });
  });

  it("keeps the ceilings restrained", () => {
    // The shine sits behind body text; past roughly this point the glass starts
    // winning contrast arguments against the words on top of it.
    expect(MAX_SPEED).toBeLessThanOrEqual(2);
    expect(MAX_GAIN).toBeLessThan(2);
    expect(MAX_PUNCH).toBeLessThan(1.1);
  });

  it("rises with loudness", () => {
    expect(reactionFor(0.7, 0).speed).toBeGreaterThan(reactionFor(0.3, 0).speed);
    expect(reactionFor(0.7, 0).gain).toBeGreaterThan(reactionFor(0.3, 0).gain);
  });

  it("keeps the beat off the sustained channels", () => {
    // A kick drum is a swell that comes back, not a new baseline, so it must
    // not move speed or brightness.
    const quiet = reactionFor(0, 1);
    expect(quiet.speed).toBe(1);
    expect(quiet.gain).toBe(1);
    expect(quiet.punch).toBe(MAX_PUNCH);
  });

  it("never shrinks the field below its resting size", () => {
    for (const hit of [0, 0.25, 0.5, 1, -1, 5]) {
      expect(reactionFor(0, hit).punch).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("shapeLevel", () => {
  it("lifts the quiet half so ordinary listening still moves the field", () => {
    expect(shapeLevel(0.25)).toBeGreaterThan(0.25);
    expect(shapeLevel(0.5)).toBeGreaterThan(0.5);
  });

  it("leaves the endpoints alone", () => {
    expect(shapeLevel(0)).toBe(0);
    expect(shapeLevel(1)).toBe(1);
  });
});

describe("fallbackReaction", () => {
  it("runs warmer and faster than rest", () => {
    const reaction = fallbackReaction(0);
    expect(reaction.speed).toBe(FALLBACK_SPEED);
    expect(reaction.gain).toBe(FALLBACK_GAIN);
    expect(reaction.speed).toBeGreaterThan(1);
    expect(reaction.gain).toBeGreaterThan(1);
  });

  it("stays gentler than a real reading", () => {
    // It knows only that something is playing, so it must not claim the
    // presence a measured signal earns.
    expect(FALLBACK_SPEED).toBeLessThan(MAX_SPEED);
    expect(FALLBACK_GAIN).toBeLessThan(MAX_GAIN);
  });

  it("breathes above rest and never below it", () => {
    for (let step = 0; step <= 12; step += 1) {
      const punch = fallbackReaction((FALLBACK_BREATH_MS * step) / 12).punch;
      expect(punch).toBeGreaterThanOrEqual(1);
      expect(punch).toBeLessThan(MAX_PUNCH);
    }
  });

  it("returns to where it started after one breath", () => {
    expect(fallbackReaction(FALLBACK_BREATH_MS).punch).toBeCloseTo(
      fallbackReaction(0).punch,
      6
    );
  });

  it("holds still for an unusable clock", () => {
    expect(fallbackReaction(Number.NaN).punch).toBeCloseTo(1, 6);
  });
});

describe("reactionCssVariables", () => {
  it("writes only the two properties CSS can use", () => {
    // Speed is absent on purpose: rewriting an animation's duration restarts
    // it, so the engine changes playback rate instead, which has no CSS
    // spelling.
    expect(reactionCssVariables(RESTING_REACTION)).toEqual({
      "--shine-audio-gain": "1.000",
      "--shine-audio-punch": "1.000"
    });
  });

  it("quantises so a steady passage writes an unchanging string", () => {
    const first = reactionCssVariables({ speed: 1, gain: 1.234_5678, punch: 1.02 });
    const second = reactionCssVariables({ speed: 1, gain: 1.234_5111, punch: 1.02 });
    expect(first).toEqual(second);
    expect(first["--shine-audio-gain"]).toBe("1.235");
  });
});
