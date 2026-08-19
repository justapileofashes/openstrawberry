/**
 * Turning a loudness reading into how the ambient field should behave.
 *
 * Everything here is pure arithmetic on numbers. The capture side - which is
 * platform-specific, permission-gated, and allowed to fail - lives in the
 * renderer engine and the trusted process; what survives into this module is a
 * spectrum snapshot and a clock delta. That split is deliberate: the part with
 * a defensible answer for every input is the part worth testing, and the part
 * that talks to an audio device is the part that has to be allowed to give up.
 *
 * Two rules shape the tuning.
 *
 * **The settings stay authoritative.** Nothing here produces a colour, an
 * intensity, or a duration. It produces *multipliers* against whatever the user
 * already chose, so someone who set a dim slow shine gets a dim slow shine that
 * moves with the music rather than the app's idea of a good level.
 *
 * **A miss reads worse than a lag.** The envelopes below attack fast and
 * release slow. A highlight that swells a frame late is indistinguishable from
 * one that swelled on time; a highlight that flickers between beats reads as
 * broken, which is why nothing here can move faster than its attack constant.
 */

/**
 * How the field should differ from its resting state.
 *
 * All three are multipliers, and all three are 1 at rest, so a silent machine
 * produces exactly the appearance the user configured.
 */
export interface AudioReaction {
  /** Animation playback rate for the drift. 1 is the configured speed. */
  readonly speed: number;
  /** Brightness multiplier against the configured shine intensity. */
  readonly gain: number;
  /** Scale applied to the field as a whole, for the beat. */
  readonly punch: number;
}

/** Silence, and what the chrome shows whenever the feature is off. */
export const RESTING_REACTION: AudioReaction = { speed: 1, gain: 1, punch: 1 };

/*
 * The ceilings, chosen for "noticeable but restrained".
 *
 * Speed tops out at double so a loud passage is unmistakably faster while the
 * pools still read as drifting rather than as racing. Gain stops short of
 * doubling because the shine sits behind body text: past roughly this point the
 * glass starts winning contrast arguments against the words on top of it.
 * Punch is small on purpose - the blobs span tens of viewport widths, so a few
 * percent of scale is already a visible swell across the whole window.
 */
export const MAX_SPEED = 2;
export const MAX_GAIN = 1.85;
export const MAX_PUNCH = 1.055;

/**
 * Below this, the machine is treated as silent rather than as quiet.
 *
 * Loopback capture never returns a clean zero: codecs dither, and an idle
 * output device still reports a hair above nothing. Without a floor the
 * adaptive gain below would take that hair as the signal and normalise room
 * noise into a light show.
 */
export const SILENCE_FLOOR = 0.045;

/**
 * The smallest peak the adaptive gain will divide by.
 *
 * This is what stops a fade-out from ending in a blaze: as the real peak
 * decays, the divisor stops here instead of approaching zero, so quiet stays
 * looking quiet.
 */
export const MIN_PEAK = 0.12;

/** How long the running peak takes to fall by half with no louder input. */
export const PEAK_HALF_LIFE_MS = 2600;

/* -------------------------------------------------------------------------- */
/* Envelopes                                                                   */
/* -------------------------------------------------------------------------- */

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Moves a value toward a target at a rate set by which direction it is going.
 *
 * Framed in milliseconds rather than in frames because the caller is a
 * `requestAnimationFrame` loop, and that loop does not run at a fixed rate: it
 * throttles in a background window, stalls under load, and runs at 120Hz on
 * hardware that can. A per-frame coefficient would make the shine visibly
 * springier on a fast display and sludgier on a slow one. Exponential decay
 * over real elapsed time gives the same envelope on all of them.
 */
export function followValue(
  current: number,
  target: number,
  deltaMs: number,
  attackMs: number,
  releaseMs: number
): number {
  if (!Number.isFinite(current)) return target;
  if (!Number.isFinite(target) || !Number.isFinite(deltaMs) || deltaMs <= 0) return current;

  const tau = target > current ? attackMs : releaseMs;
  if (tau <= 0) return target;

  /*
   * Clamped because a tab that was hidden for a minute hands back one enormous
   * delta on its first frame. Without this the field would snap to the new
   * level in a single step, which is the one visible jump this whole module
   * exists to avoid.
   */
  const step = Math.min(deltaMs, 250);
  return current + (target - current) * (1 - Math.exp(-step / tau));
}

/**
 * The running loudest-recent-thing, used as the divisor for adaptive gain.
 *
 * Loopback hands back whatever the system mixer is doing, so absolute levels
 * say more about the user's volume knob than about the music. Normalising
 * against a decaying peak is what makes the field behave the same at 20% volume
 * as at 80%, which is the behaviour someone expects from a visualiser.
 */
export function decayPeak(peak: number, level: number, deltaMs: number): number {
  const safePeak = Number.isFinite(peak) ? peak : MIN_PEAK;
  const elapsed = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
  const decayed = safePeak * Math.pow(0.5, elapsed / PEAK_HALF_LIFE_MS);
  return Math.max(clamp01(level), decayed, MIN_PEAK);
}

/**
 * A level as a fraction of the recent peak, with silence held at zero.
 *
 * The floor check comes first and is absolute. Everything after it is relative,
 * and relative measures have no useful answer to "how loud is nothing".
 */
export function normalizeAgainstPeak(level: number, peak: number): number {
  if (!Number.isFinite(level) || level <= SILENCE_FLOOR) return 0;
  const divisor = Math.max(peak, MIN_PEAK);
  return clamp01((level - SILENCE_FLOOR) / Math.max(divisor - SILENCE_FLOOR, MIN_PEAK));
}

/* -------------------------------------------------------------------------- */
/* Reading a spectrum                                                          */
/* -------------------------------------------------------------------------- */

/** Lowest frequency worth reading. Below this is rumble and DC offset. */
export const BASS_FROM_HZ = 30;
/** Where the kick drum stops and the bass guitar takes over. */
export const BASS_TO_HZ = 160;
/** The band that carries perceived loudness for most material. */
export const BODY_FROM_HZ = 120;
export const BODY_TO_HZ = 6000;

/**
 * The bin holding a given frequency.
 *
 * Each bin of an FFT covers `sampleRate / fftSize` Hz, so this is a division
 * dressed up with guards. The guards matter because `AudioContext.sampleRate`
 * is whatever the output device reports, and a device that reports something
 * absurd should cost a dull-looking shine rather than an exception inside a
 * frame callback.
 */
export function binForHz(hz: number, sampleRate: number, fftSize: number): number {
  if (!Number.isFinite(hz) || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  if (!Number.isFinite(fftSize) || fftSize <= 0) return 0;

  const binCount = Math.floor(fftSize / 2);
  const perBin = sampleRate / fftSize;
  return Math.min(binCount - 1, Math.max(0, Math.round(hz / perBin)));
}

/**
 * Mean magnitude across a bin range, as a 0..1 fraction.
 *
 * `getByteFrequencyData` fills bytes, so the division by 255 is what turns a
 * platform detail into the unit-range number the rest of this module speaks.
 * An empty or reversed range averages to zero rather than to NaN, because the
 * caller derives its bounds from a sample rate it did not choose.
 */
export function bandAverage(bins: ArrayLike<number>, from: number, to: number): number {
  const first = Math.max(0, Math.min(from, to));
  const last = Math.min(bins.length - 1, Math.max(from, to));
  if (last < first) return 0;

  let total = 0;
  for (let index = first; index <= last; index += 1) {
    const value = bins[index];
    total += typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  return clamp01(total / (last - first + 1) / 255);
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Perceptual shaping.
 *
 * Loudness is roughly logarithmic and a linear map spends most of its range on
 * material that is already loud, which leaves ordinary listening levels looking
 * inert. The exponent pulls the quiet half of the scale upward so a podcast at
 * a civil volume still moves the field.
 */
const SHAPE = 0.72;

export function shapeLevel(level: number): number {
  return Math.pow(clamp01(level), SHAPE);
}

/**
 * The reaction for a shaped loudness and a shaped transient.
 *
 * Loudness drives speed and brightness, because those are the two things a
 * sustained passage should hold. The transient drives only the punch, because a
 * kick drum should be a swell that comes back rather than a new baseline - and
 * keeping them on separate inputs is what stops a loud quiet song from sitting
 * permanently at full scale.
 */
export function reactionFor(loudness: number, transient: number): AudioReaction {
  const level = clamp01(loudness);
  const hit = clamp01(transient);

  return {
    speed: 1 + level * (MAX_SPEED - 1),
    gain: 1 + level * (MAX_GAIN - 1),
    punch: 1 + hit * (MAX_PUNCH - 1)
  };
}

/*
 * The fallback, for a machine whose audio cannot be captured.
 *
 * Deliberately not a fake beat. A pulse that does not match the music is worse
 * than no pulse at all - the eye catches the disagreement immediately, and the
 * effect reads as broken rather than as decorative. So this states only what is
 * actually known: something is playing. The field runs warmer and faster and
 * breathes slowly, and it claims nothing about rhythm it cannot hear.
 */
export const FALLBACK_SPEED = 1.4;
export const FALLBACK_GAIN = 1.25;
const FALLBACK_BREATH = 0.014;

/** One full breath of the fallback pulse, in milliseconds. */
export const FALLBACK_BREATH_MS = 4200;

export function fallbackReaction(elapsedMs: number): AudioReaction {
  const phase = Number.isFinite(elapsedMs) ? (elapsedMs % FALLBACK_BREATH_MS) / FALLBACK_BREATH_MS : 0;

  return {
    speed: FALLBACK_SPEED,
    gain: FALLBACK_GAIN,
    // Offset so the breath sits entirely above rest: the field only ever swells
    // out of its configured size, never shrinks below it.
    punch: 1 + FALLBACK_BREATH * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI))
  };
}

/* -------------------------------------------------------------------------- */
/* Handing it to CSS                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Rounding, so a value written every frame does not churn the style engine.
 *
 * Three decimals is far finer than the eye resolves on a blurred gradient, and
 * quantising here means a steady passage writes the same string repeatedly -
 * which the caller can then skip entirely.
 */
function quantize(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

/**
 * The custom properties the ambient field reads.
 *
 * Speed is absent on purpose. Rewriting an animation's duration restarts it,
 * which snaps every pool to a new position mid-drift; the engine changes the
 * running animation's playback rate instead, and that has no CSS spelling.
 */
export function reactionCssVariables(
  reaction: AudioReaction
): Readonly<Record<string, string>> {
  return {
    "--shine-audio-gain": quantize(reaction.gain),
    "--shine-audio-punch": quantize(reaction.punch)
  };
}
