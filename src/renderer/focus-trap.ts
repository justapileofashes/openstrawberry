/**
 * Keeping the keyboard inside an open panel.
 *
 * Every panel in this app is a `role="dialog"` drawn over the chrome, and a
 * dialog that does not hold focus is a trap of a different kind: Tab walks out
 * of it into controls the user cannot see, and the thing they were reading stops
 * responding to the keyboard for no visible reason.
 *
 * Three behaviours, and the third is the one people notice when it is missing:
 *
 *   1. Tab and Shift+Tab cycle within the panel, wrapping at both ends.
 *   2. Focus moves into the panel when it opens.
 *   3. Focus returns to whatever had it when the panel closes. Without this a
 *      user who opened a panel from the keyboard is dropped at the top of the
 *      document when they close it, and has to walk back.
 *
 * The selection and index arithmetic are pure so they can be tested; only the
 * hook at the bottom touches the DOM, and the test runner covers `.ts` rather
 * than `.tsx`, which is why this is not inside a component.
 */

import { useEffect, useRef } from "react";

/**
 * What counts as focusable.
 *
 * `[href]` is deliberately absent: the chrome contains no links, and anything
 * that navigates does so through a button so the navigation policy sees it.
 * A negative tabindex is excluded because it means "focusable by script, not by
 * Tab" - honouring it is what lets a panel park focus somewhere without putting
 * it in the cycle.
 */
export const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(", ");

/** The minimal element shape this module needs, so tests need no real DOM. */
export interface FocusableLike {
  readonly hidden?: boolean;
  focus: () => void;
}

/**
 * Where focus should land next.
 *
 * Wraps at both ends, because a dialog's last control leading back to its first
 * is what "the keyboard is inside this panel" feels like. Returns 0 for an empty
 * set so a caller can index without a guard.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return 0;

  /*
   * Focus outside the panel is a sentinel, not a position, and the two behave
   * differently under the wrap below. Stepping forward from -1 happens to land
   * on the first, but stepping back lands on the second-to-last rather than the
   * last, which is nobody's expectation of Shift+Tab into a panel. Handled
   * explicitly rather than left to arithmetic that is only accidentally right
   * in one direction.
   */
  if (current < 0) return backwards ? count - 1 : 0;

  const step = backwards ? -1 : 1;
  return (((current + step) % count) + count) % count;
}

/**
 * The index of the element that currently has focus, or -1.
 *
 * Separated so the wrap arithmetic can be tested against a known position
 * without a document.
 */
export function focusedIndex<T>(elements: readonly T[], active: T | null): number {
  if (active === null) return -1;
  return elements.indexOf(active);
}

/**
 * Whether a keypress should move focus within the panel.
 *
 * Only a bare Tab or Shift+Tab. A Tab carrying Control or Alt belongs to the
 * window or the operating system, and swallowing it would take a shortcut away
 * from the user to enforce a rule about a panel.
 */
export function isTraversalKey(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): boolean {
  if (event.key !== "Tab") return false;
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Traps the keyboard inside a panel while it is open.
 *
 * Pass the panel's container ref. The hook moves focus in on mount, cycles Tab
 * within it, and restores focus to whatever had it before on unmount.
 *
 * It deliberately does not fight for focus continuously: a panel that steals
 * focus back on every render makes text fields unusable. It acts once on mount
 * and thereafter only when Tab is pressed.
 */
export function useFocusTrap(container: React.RefObject<HTMLElement | null>): void {
  // Captured before focus moves, so the element to restore to is the one that
  // was focused when the panel opened rather than something inside it.
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;

    const previous = document.activeElement;
    restoreTo.current = previous instanceof HTMLElement ? previous : null;

    const focusable = (): HTMLElement[] =>
      [...element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (candidate) => candidate.offsetParent !== null || candidate === document.activeElement
      );

    // Moving focus in is what makes the panel keyboard-reachable at all. The
    // container itself is the fallback for a panel with no controls yet.
    const first = focusable()[0];
    if (first !== undefined) first.focus();
    else element.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTraversalKey(event)) return;

      const elements = focusable();
      if (elements.length === 0) return;

      event.preventDefault();

      const active = document.activeElement;
      const index = focusedIndex(elements, active instanceof HTMLElement ? active : null);

      // An index of -1 means focus is somewhere outside the panel, and the
      // wrap treats that as "before the first", which lands on the first.
      const target = elements[nextFocusIndex(index, elements.length, event.shiftKey)];
      target?.focus();
    };

    element.addEventListener("keydown", onKeyDown);

    return () => {
      element.removeEventListener("keydown", onKeyDown);

      // Restored only if it is still in the document; a control that has since
      // been removed would throw focus nowhere useful.
      const target = restoreTo.current;
      if (target !== null && document.contains(target)) target.focus();
    };
  }, [container]);
}
