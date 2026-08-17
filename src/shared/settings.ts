/**
 * User-configurable appearance settings.
 *
 * These are purely visual preferences with no security meaning, so they live in
 * renderer-owned storage rather than crossing the IPC boundary. Keeping them
 * out of the trusted process avoids widening the attack surface for something
 * that only decides how a highlight moves.
 *
 * Note this deliberately departs from the original Obsidian Relay rule that
 * motion and glass are always on with no user-facing toggles. The controls were
 * requested explicitly; the defaults keep the shipped look unchanged, and the
 * default shine stays achromatic so the palette rule still holds unless a user
 * opts out of it.
 */

export interface AppearanceSettings {
  /** Master switch for the drifting shine. Glass itself is never disabled. */
  readonly shineEnabled: boolean;
  /** Peak opacity of the shine, as a percentage. */
  readonly shineIntensity: number;
  /** Shine colour as a `#rrggbb` string. */
  readonly shineColor: string;
  /** Drift speed, as a percentage. Higher is faster. */
  readonly shineSpeed: number;
  /** Master switch for non-essential motion across the chrome. */
  readonly motionEnabled: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  shineEnabled: true,
  shineIntensity: 42,
  // Cool near-white: reads as a specular highlight rather than as colour.
  shineColor: "#dbe6fa",
  shineSpeed: 55,
  motionEnabled: true
};

/*
 * The cycle bounds. The previous range topped out at 48s, which put the default
 * near half a minute per pass — slow enough that the light read as static.
 * A lava lamp should be unhurried but visibly moving.
 */
export const SHINE_SPEED_MIN_SECONDS = 5;
export const SHINE_SPEED_MAX_SECONDS = 30;

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

function clampPercent(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Reads settings from storage that may be stale, hand-edited, or absent.
 * Anything unrecognised falls back to the default rather than throwing, so a
 * bad value can never stop the chrome from rendering.
 */
export function parseAppearance(raw: unknown): AppearanceSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_APPEARANCE;
  }

  const source = raw as Record<string, unknown>;
  const color = source["shineColor"];

  return {
    shineEnabled: booleanOr(source["shineEnabled"], DEFAULT_APPEARANCE.shineEnabled),
    shineIntensity: clampPercent(source["shineIntensity"], DEFAULT_APPEARANCE.shineIntensity),
    shineColor:
      typeof color === "string" && HEX_COLOR.test(color)
        ? color.toLowerCase()
        : DEFAULT_APPEARANCE.shineColor,
    shineSpeed: clampPercent(source["shineSpeed"], DEFAULT_APPEARANCE.shineSpeed),
    motionEnabled: booleanOr(source["motionEnabled"], DEFAULT_APPEARANCE.motionEnabled)
  };
}

/** `#rrggbb` to the `r, g, b` triplet an rgba() custom property needs. */
export function hexToRgbTriplet(hex: string): string {
  if (!HEX_COLOR.test(hex)) return hexToRgbTriplet(DEFAULT_APPEARANCE.shineColor);
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

/**
 * Maps the speed percentage to a drift duration. Higher speed means a shorter
 * cycle, so the scale is inverted.
 */
export function shineDurationSeconds(speedPercent: number): number {
  const clamped = Math.min(100, Math.max(0, speedPercent));
  const span = SHINE_SPEED_MAX_SECONDS - SHINE_SPEED_MIN_SECONDS;
  return Math.round(SHINE_SPEED_MAX_SECONDS - (clamped / 100) * span);
}

/** The CSS custom properties the chrome reads for its shine. */
export function appearanceCssVariables(
  settings: AppearanceSettings
): Readonly<Record<string, string>> {
  return {
    "--shine-rgb": hexToRgbTriplet(settings.shineColor),
    "--shine-intensity": String(settings.shineIntensity),
    "--shine-duration": `${shineDurationSeconds(settings.shineSpeed)}s`
  };
}
