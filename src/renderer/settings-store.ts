/**
 * Appearance settings persistence and application.
 *
 * These are renderer-owned visual preferences, so they persist in the renderer's
 * own storage rather than crossing IPC. Nothing here is security-relevant, and
 * keeping it out of the trusted process avoids widening that surface.
 */
import {
  appearanceCssVariables,
  DEFAULT_APPEARANCE,
  parseAppearance,
  type AppearanceSettings
} from "../shared/settings.js";

const STORAGE_KEY = "openstrawberry.appearance.v1";

export function loadAppearance(): AppearanceSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_APPEARANCE;
    return parseAppearance(JSON.parse(raw) as unknown);
  } catch {
    // Storage can be unavailable or hold non-JSON; defaults keep the chrome up.
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(settings: AppearanceSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A failed write only costs persistence, never the current session.
  }
}

/**
 * Pushes settings onto the document root.
 *
 * Values reach CSS only as pre-validated numbers and an `r, g, b` triplet, so a
 * stored value cannot inject arbitrary declarations.
 */
export function applyAppearance(settings: AppearanceSettings): void {
  const root = document.documentElement;

  for (const [name, value] of Object.entries(appearanceCssVariables(settings))) {
    root.style.setProperty(name, value);
  }

  root.classList.toggle("shine-off", !settings.shineEnabled);
  root.classList.toggle("motion-off", !settings.motionEnabled);
}
