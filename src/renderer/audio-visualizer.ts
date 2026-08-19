/**
 * Driving the ambient field from what the machine is playing.
 *
 * This is the impure half of the feature: it opens an audio device, runs a
 * frame loop, and writes to the document. Every decision it makes about *how
 * much* to move is delegated to `../shared/audio-reactive.js`, which is pure and
 * tested. What lives here is the part that is allowed to fail.
 *
 * And it is allowed to fail quietly, which is the rule that shapes the whole
 * module. Capture is unavailable on platforms other than Windows, can be
 * refused, and can come back suspended. None of that is worth a message: the
 * user asked for a nicer highlight, not for a subsystem. Every failure path
 * lands on the same fallback - the field runs warmer and faster while a tab is
 * making noise - which is a smaller version of the same idea and needs no
 * capture at all.
 *
 * Two implementation notes that are easy to undo by accident:
 *
 * **The analyser is never connected to a destination.** It is fed by the
 * loopback stream, which *is* the speakers. Connecting it onward would play the
 * system's own output back into itself.
 *
 * **Speed is applied as a playback rate, not as a duration.** Rewriting
 * `--shine-duration` restarts the keyframe animations, which snaps every pool to
 * a new position mid-drift. `Animation.playbackRate` preserves the current time
 * and only changes how fast it advances from there, so the field speeds up
 * without ever jumping.
 */
import {
  bandAverage,
  BASS_FROM_HZ,
  BASS_TO_HZ,
  binForHz,
  BODY_FROM_HZ,
  BODY_TO_HZ,
  clamp01,
  decayPeak,
  fallbackReaction,
  followValue,
  normalizeAgainstPeak,
  reactionCssVariables,
  reactionFor,
  RESTING_REACTION,
  shapeLevel,
  type AudioReaction
} from "../shared/audio-reactive.js";

/** Enough resolution to separate a kick drum from a bass line. */
const FFT_SIZE = 2048;

/*
 * Envelope constants, in milliseconds.
 *
 * Loudness carries speed and brightness, so it is slow in both directions: those
 * are properties of a passage, not of a moment. The punch is quick to rise and
 * unhurried to fall, which is the shape of a struck drum and the reason a beat
 * reads as a swell rather than as a flicker.
 */
const LOUDNESS_ATTACK_MS = 90;
const LOUDNESS_RELEASE_MS = 420;
const PUNCH_ATTACK_MS = 28;
const PUNCH_RELEASE_MS = 220;
/** How fast the reference the transient detector measures against moves. */
const BASS_BASELINE_MS = 800;

/** How far above its own recent average the bass must sit to read as a hit. */
const TRANSIENT_GAIN = 2.6;
/** A little sustained presence, so a wall of sound is not perfectly still. */
const SUSTAIN_IN_PUNCH = 0.2;

/** Playback-rate changes smaller than this are not worth a write. */
const RATE_EPSILON = 0.004;

export interface VisualizerHandle {
  /**
   * Whether any tab is currently making noise.
   *
   * Used only by the fallback. Real capture hears the whole machine, including
   * applications this browser knows nothing about, so when it is working this
   * is ignored entirely - which is the point of capturing at the mixer.
   */
  readonly setAudible: (audible: boolean) => void;
  readonly stop: () => void;
}

/**
 * Starts the visualiser.
 *
 * Returns immediately; capture is negotiated in the background and the field
 * runs on the fallback until it either arrives or is refused.
 */
export function startAudioVisualizer(): VisualizerHandle {
  const root = document.documentElement;

  let stopped = false;
  let frame = 0;
  let lastTimestamp = 0;
  let audible = false;

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  /*
   * Pinned to a plain `ArrayBuffer` rather than left as `ArrayBufferLike`.
   * `getByteFrequencyData` will not accept a view that might be backed by a
   * `SharedArrayBuffer`, and the buffer this owns never is.
   */
  let bins: Uint8Array<ArrayBuffer> | null = null;
  let bassRange: readonly [number, number] = [0, 0];
  let bodyRange: readonly [number, number] = [0, 0];

  // Envelope state. Held here rather than in the shared module so the maths
  // stays a set of functions with no memory to reason about.
  let loudness = 0;
  let punch = 0;
  let bassBaseline = 0;
  let bodyPeak = 0;
  let bassPeak = 0;

  let animations: readonly Animation[] = [];
  let lastRate = 1;
  let lastVariables: Record<string, string> = {};

  /* ---------------------------------------------------------------------- */
  /* Applying a reaction                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * The drift animations, re-read until they exist.
   *
   * The engine can start before the field has painted, and a cached empty list
   * would leave the speed permanently stuck at rest.
   */
  function driftAnimations(): readonly Animation[] {
    if (animations.length > 0) return animations;

    const found: Animation[] = [];
    for (const blob of document.querySelectorAll(".ambient-blob")) {
      // `getAnimations` is the only way to reach a running CSS animation's
      // playback rate; there is no declarative spelling for it.
      found.push(...blob.getAnimations());
    }

    animations = found;
    return animations;
  }

  function apply(reaction: AudioReaction): void {
    const variables = reactionCssVariables(reaction);
    for (const [name, value] of Object.entries(variables)) {
      // Quantised upstream, so a steady passage writes the same string every
      // frame and this skips it rather than churning the style engine.
      if (lastVariables[name] !== value) root.style.setProperty(name, value);
    }
    lastVariables = variables;

    if (Math.abs(reaction.speed - lastRate) < RATE_EPSILON) return;
    lastRate = reaction.speed;
    for (const animation of driftAnimations()) {
      try {
        animation.playbackRate = reaction.speed;
      } catch {
        // An animation cancelled between the query and the write is not worth
        // interrupting the frame for.
      }
    }
  }

  /** Puts the field back exactly as the user's settings describe it. */
  function reset(): void {
    for (const name of Object.keys(reactionCssVariables(RESTING_REACTION))) {
      root.style.removeProperty(name);
    }
    lastVariables = {};

    for (const animation of animations) {
      try {
        animation.playbackRate = 1;
      } catch {
        // Same reasoning as above, and this path runs during teardown where
        // there is even less to be gained from noticing.
      }
    }
    lastRate = 1;
    animations = [];
  }

  /* ---------------------------------------------------------------------- */
  /* The frame loop                                                          */
  /* ---------------------------------------------------------------------- */

  /** Reads the spectrum and advances the envelopes. */
  function measure(deltaMs: number): AudioReaction {
    // Unreachable from `tick`, which checks both first. Resting rather than
    // falling back, because a caller that got here has no evidence of sound.
    if (analyser === null || bins === null) return RESTING_REACTION;

    analyser.getByteFrequencyData(bins);

    const body = bandAverage(bins, bodyRange[0], bodyRange[1]);
    const bass = bandAverage(bins, bassRange[0], bassRange[1]);

    bodyPeak = decayPeak(bodyPeak, body, deltaMs);
    bassPeak = decayPeak(bassPeak, bass, deltaMs);

    const bodyLevel = shapeLevel(normalizeAgainstPeak(body, bodyPeak));
    const bassLevel = normalizeAgainstPeak(bass, bassPeak);

    loudness = followValue(loudness, bodyLevel, deltaMs, LOUDNESS_ATTACK_MS, LOUDNESS_RELEASE_MS);

    /*
     * A hit is bass above its own recent average, not bass in absolute terms.
     * Measuring against a moving baseline is what separates a kick from a bass
     * note held under it - the held note raises the baseline with itself and
     * stops registering, exactly as it should.
     */
    bassBaseline = followValue(bassBaseline, bassLevel, deltaMs, BASS_BASELINE_MS, BASS_BASELINE_MS);
    const target = clamp01(
      Math.max(0, bassLevel - bassBaseline) * TRANSIENT_GAIN + loudness * SUSTAIN_IN_PUNCH
    );
    punch = followValue(punch, target, deltaMs, PUNCH_ATTACK_MS, PUNCH_RELEASE_MS);

    return reactionFor(loudness, punch);
  }

  function tick(timestamp: number): void {
    if (stopped) return;
    frame = window.requestAnimationFrame(tick);

    const deltaMs = lastTimestamp === 0 ? 16 : timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    /*
     * `context.state` is the honest test for whether capture is usable. An
     * autoplay-suspended context returns a valid, entirely silent spectrum,
     * which would otherwise read as "the machine is quiet" forever.
     */
    if (analyser !== null && context?.state === "running") {
      apply(measure(deltaMs));
      return;
    }

    apply(audible ? fallbackReaction(timestamp) : RESTING_REACTION);
  }

  /* ---------------------------------------------------------------------- */
  /* Capture                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Negotiates the loopback tap and builds the graph behind it.
   *
   * Audio only, and that is not a preference - it is the only request the
   * trusted process can answer. Electron rejects a display-media call whose
   * video half went unsatisfied, and the handler there never returns a video
   * source, so asking for `video: true` here would fail every time. The
   * standard normally forbids an audio-only `getDisplayMedia`; Electron permits
   * it precisely so a handler like that one can be written.
   *
   * The video track dropped below is therefore expected never to exist. It is
   * belt-and-braces against a future where it does, because a screen capture
   * left running would be a far worse bug than a missing highlight.
   */
  async function openCapture(): Promise<void> {
    if (navigator.mediaDevices?.getDisplayMedia === undefined) return;

    const opened = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
    if (stopped) {
      for (const track of opened.getTracks()) track.stop();
      return;
    }

    for (const track of opened.getVideoTracks()) {
      track.stop();
      opened.removeTrack(track);
    }

    if (opened.getAudioTracks().length === 0) {
      // Nothing to listen to. Treated exactly like a refusal.
      for (const track of opened.getTracks()) track.stop();
      return;
    }

    stream = opened;

    const audio = new AudioContext();
    const source = audio.createMediaStreamSource(opened);
    const node = audio.createAnalyser();
    node.fftSize = FFT_SIZE;
    /*
     * Some smoothing in the analyser itself, on top of the envelopes. It costs
     * nothing and takes the worst of the bin-to-bin noise out before any of the
     * maths downstream sees it.
     */
    node.smoothingTimeConstant = 0.62;

    // Connected as a leaf. See the note at the top about why this must never
    // reach a destination.
    source.connect(node);

    bassRange = [
      binForHz(BASS_FROM_HZ, audio.sampleRate, FFT_SIZE),
      binForHz(BASS_TO_HZ, audio.sampleRate, FFT_SIZE)
    ];
    bodyRange = [
      binForHz(BODY_FROM_HZ, audio.sampleRate, FFT_SIZE),
      binForHz(BODY_TO_HZ, audio.sampleRate, FFT_SIZE)
    ];

    bins = new Uint8Array(node.frequencyBinCount);
    context = audio;
    analyser = node;

    await resume(audio);
  }

  /**
   * Brings the context out of autoplay suspension.
   *
   * A context created before the user has interacted with the window starts
   * suspended. Rather than guess when that has changed, this retries on the
   * next interaction of any kind; until then the frame loop sees a non-running
   * context and uses the fallback.
   */
  async function resume(audio: AudioContext): Promise<void> {
    try {
      await audio.resume();
    } catch {
      // Nothing to do but wait for a gesture.
    }

    if (stopped || audio.state === "running") return;

    const retry = (): void => {
      void audio.resume().catch(() => undefined);
    };
    for (const event of ["pointerdown", "keydown"] as const) {
      window.addEventListener(event, retry, { once: true, passive: true });
    }
  }

  /* ---------------------------------------------------------------------- */

  frame = window.requestAnimationFrame(tick);

  void openCapture().catch(() => {
    // Refused, unsupported, or gone mid-negotiation. The loop is already
    // running on the fallback and simply stays there.
  });

  return {
    setAudible: (next: boolean): void => {
      audible = next;
    },
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      window.cancelAnimationFrame(frame);

      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;

      void context?.close().catch(() => undefined);
      context = null;
      analyser = null;
      bins = null;

      reset();
    }
  };
}
