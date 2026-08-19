import { describe, expect, it } from "vitest";
import {
  FOCUSABLE_SELECTOR,
  focusedIndex,
  isTraversalKey,
  nextFocusIndex
} from "./focus-trap.js";

function key(overrides: Partial<Parameters<typeof isTraversalKey>[0]> = {}) {
  return { key: "Tab", ctrlKey: false, metaKey: false, altKey: false, ...overrides };
}

describe("FOCUSABLE_SELECTOR", () => {
  it("excludes disabled controls", () => {
    // A disabled button is not a stop on the way round.
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("input:not([disabled])");
  });

  it("excludes a negative tabindex", () => {
    // Negative means "focusable by script, not by Tab", which is what lets a
    // panel park focus somewhere without putting it in the cycle.
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it("names no link selector, because the chrome has no links", () => {
    // Anything that navigates does so through a button, so the navigation
    // policy sees it. `[href]` is the signal; a bare "a" substring is not, since
    // it also occurs inside "textarea".
    expect(FOCUSABLE_SELECTOR).not.toContain("[href]");
  });
});

describe("nextFocusIndex", () => {
  it("moves forward and back", () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(2, 3, true)).toBe(1);
  });

  it("wraps at both ends", () => {
    // The last control leading back to the first is what "the keyboard is
    // inside this panel" feels like.
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
  });

  it("lands on the first when focus was outside the panel", () => {
    // -1 is "before the first", so a forward step arrives at 0.
    expect(nextFocusIndex(-1, 3, false)).toBe(0);
  });

  it("lands on the last when stepping back from outside", () => {
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
  });

  it("is safe for an empty panel", () => {
    expect(nextFocusIndex(0, 0, false)).toBe(0);
    expect(nextFocusIndex(5, 0, true)).toBe(0);
  });

  it("stays put in a panel with one control", () => {
    expect(nextFocusIndex(0, 1, false)).toBe(0);
    expect(nextFocusIndex(0, 1, true)).toBe(0);
  });
});

describe("focusedIndex", () => {
  it("finds the focused element", () => {
    expect(focusedIndex(["a", "b", "c"], "b")).toBe(1);
  });

  it("is -1 for nothing focused, or focus outside the set", () => {
    expect(focusedIndex(["a", "b"], null)).toBe(-1);
    expect(focusedIndex(["a", "b"], "z")).toBe(-1);
  });

  it("is -1 for an empty set", () => {
    expect(focusedIndex([], "a")).toBe(-1);
  });
});

describe("isTraversalKey", () => {
  it("claims a bare Tab and Shift+Tab", () => {
    expect(isTraversalKey(key())).toBe(true);
    // Shift is the direction, not a disqualifier.
    expect(isTraversalKey({ ...key(), key: "Tab" })).toBe(true);
  });

  it("leaves a modified Tab to the window", () => {
    // Ctrl+Tab and friends belong to the app or the OS; swallowing them would
    // take a shortcut away to enforce a rule about a panel.
    expect(isTraversalKey(key({ ctrlKey: true }))).toBe(false);
    expect(isTraversalKey(key({ metaKey: true }))).toBe(false);
    expect(isTraversalKey(key({ altKey: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    for (const name of ["Enter", "Escape", "a", "ArrowDown", " "]) {
      expect(isTraversalKey(key({ key: name })), name).toBe(false);
    }
  });
});
