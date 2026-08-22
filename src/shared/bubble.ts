/**
 * The detached text bubble's contract.
 *
 * A page is a native view the compositor draws above the DOM, so a bubble the
 * chrome draws in its own document is only visible where no page can reach:
 * inside the chrome's own bands. Most bubbles have one — a top-bar button has
 * the bar's slack and the frame gutter beneath it, which is what `--bubble-lane`
 * in the stylesheet measures. The tab rail has none: its bubbles fly out
 * sideways over a pane, where a page paints straight over them.
 *
 * Those bubbles are therefore drawn by a small window the trusted process owns
 * and holds above the chrome, and this module is what the two sides agree on.
 *
 * What crosses is a string and a rectangle, and both are deliberately weak. The
 * string is put on screen as text and never as markup, so a tab title — which is
 * whatever a page chose to call itself — cannot become an element. The rectangle
 * is in the chrome's *client* coordinates, and the trusted process resolves it
 * against the window it already owns rather than accepting a screen position, so
 * a renderer asking for a bubble can never place one outside its own window.
 */

import { requireInteger, requirePlainObject, requireString } from "./ipc-validation.js";

/**
 * Long enough for a real tab title, short enough that the window this sizes can
 * never be asked to be enormous. The chrome clamps the drawn width in CSS as
 * well; this is the bound the trusted process does not have to take on faith.
 */
export const MAX_BUBBLE_TEXT_LENGTH = 256;

/** Bounds bubble geometry to something a real display could produce. */
export const MAX_BUBBLE_DIMENSION = 20_000;

/** A rectangle, in whichever coordinate space its holder documents. */
export interface BubbleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A request to show hover text.
 *
 * `rect` is where the chrome's own layout put the (hidden) bubble element, in
 * client coordinates. The chrome measures rather than calculates, so the
 * stylesheet stays the one place bubble placement is decided.
 */
export interface BubbleRequest {
  readonly text: string;
  readonly rect: BubbleRect;
}

export function parseBubblePayload(raw: unknown): BubbleRequest {
  const root = requirePlainObject(raw, "Bubble payload");
  const rect = requirePlainObject(root["rect"], "Bubble rect");

  return {
    text: requireString(root["text"], "Bubble text", MAX_BUBBLE_TEXT_LENGTH),
    rect: {
      x: requireInteger(rect["x"], "Bubble x", -MAX_BUBBLE_DIMENSION, MAX_BUBBLE_DIMENSION),
      y: requireInteger(rect["y"], "Bubble y", -MAX_BUBBLE_DIMENSION, MAX_BUBBLE_DIMENSION),
      width: requireInteger(rect["width"], "Bubble width", 1, MAX_BUBBLE_DIMENSION),
      height: requireInteger(rect["height"], "Bubble height", 1, MAX_BUBBLE_DIMENSION)
    }
  };
}

/**
 * How much larger than the bubble its window is made.
 *
 * Windows will not hand out a window as short as a bubble — around twenty pixels
 * — and quietly returns a taller one instead, which a bubble sized to fill its
 * window would then stretch to. So the window is deliberately bigger than what
 * it draws: the bubble keeps its own size in the window's top-left corner, and
 * the slack around it is transparent and click-through, which makes an oversized
 * window an invisible one.
 */
export const BUBBLE_WINDOW_MARGIN = 24;

/** Comfortably clear of the shortest window the platform will actually give. */
export const MIN_BUBBLE_WINDOW_HEIGHT = 64;

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

/**
 * Where the bubble window goes, in screen coordinates.
 *
 * `content` is the chrome window's content bounds — the same rectangle the
 * client coordinates in `rect` are relative to — so the conversion is an offset
 * and then a clamp. The clamp is the load-bearing half: it is what makes "the
 * bubble is drawn inside the chrome's own window" true of every request rather
 * than only of well-behaved ones, including a stale rectangle that arrives after
 * the window has been made smaller. It is applied to the bubble's own rectangle
 * rather than to the window's, because the bubble is what is visible; the slack
 * beyond it is empty in every direction.
 */
export function bubbleWindowBounds(rect: BubbleRect, content: BubbleRect): BubbleRect {
  return {
    x: clamp(content.x + rect.x, content.x, content.x + content.width - rect.width),
    y: clamp(content.y + rect.y, content.y, content.y + content.height - rect.height),
    width: rect.width + BUBBLE_WINDOW_MARGIN,
    height: Math.max(rect.height + BUBBLE_WINDOW_MARGIN, MIN_BUBBLE_WINDOW_HEIGHT)
  };
}

/** Whether two requests would put the same text in the same place. */
export function sameBubble(left: BubbleRequest | null, right: BubbleRequest | null): boolean {
  if (left === null || right === null) return left === right;

  return (
    left.text === right.text &&
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height
  );
}
