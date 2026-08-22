import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./bridge.js";
import { IpcValidationError } from "./ipc-validation.js";
import {
  BUBBLE_WINDOW_MARGIN,
  MAX_BUBBLE_TEXT_LENGTH,
  MIN_BUBBLE_WINDOW_HEIGHT,
  bubbleWindowBounds,
  parseBubblePayload,
  sameBubble,
  type BubbleRect
} from "./bubble.js";

const RECT: BubbleRect = { x: 66, y: 120, width: 90, height: 21 };
const CONTENT: BubbleRect = { x: 1000, y: 500, width: 1440, height: 900 };

/** Overrides are untyped on purpose: this is a runtime validator being tested. */
function payload(overrides: Record<string, unknown> = {}): unknown {
  return { text: "Example tab", rect: { ...RECT }, ...overrides };
}

describe("parseBubblePayload", () => {
  it("accepts a well-formed request", () => {
    expect(parseBubblePayload(payload())).toEqual({ text: "Example tab", rect: RECT });
  });

  it("refuses text longer than the bound", () => {
    const text = "x".repeat(MAX_BUBBLE_TEXT_LENGTH + 1);
    expect(() => parseBubblePayload(payload({ text }))).toThrow(IpcValidationError);
  });

  it("refuses a rectangle with no area, so no window is asked to be nothing", () => {
    expect(() => parseBubblePayload(payload({ rect: { ...RECT, width: 0 } }))).toThrow(
      IpcValidationError
    );
  });

  it("refuses non-integer geometry rather than rounding it", () => {
    expect(() => parseBubblePayload(payload({ rect: { ...RECT, y: 12.5 } }))).toThrow(
      IpcValidationError
    );
  });

  it("refuses a payload carrying no rectangle at all", () => {
    expect(() => parseBubblePayload({ text: "Example tab" })).toThrow(IpcValidationError);
  });
});

describe("bubbleWindowBounds", () => {
  it("resolves client coordinates against the window that owns them", () => {
    const bounds = bubbleWindowBounds(RECT, CONTENT);

    expect(bounds.x).toBe(1066);
    expect(bounds.y).toBe(620);
  });

  it("makes the window larger than the bubble it draws", () => {
    const bounds = bubbleWindowBounds(RECT, CONTENT);

    expect(bounds.width).toBe(RECT.width + BUBBLE_WINDOW_MARGIN);
    expect(bounds.height).toBeGreaterThanOrEqual(MIN_BUBBLE_WINDOW_HEIGHT);
  });

  /*
   * The clamp is the whole security story of this conversion: the renderer names
   * a position inside its own document, and nothing it can send resolves to a
   * rectangle outside the window it lives in.
   */
  it("keeps a bubble inside the window when the request points past its edge", () => {
    const bounds = bubbleWindowBounds({ x: 5000, y: 4000, width: 90, height: 21 }, CONTENT);

    expect(bounds.x).toBe(CONTENT.x + CONTENT.width - 90);
    expect(bounds.y).toBe(CONTENT.y + CONTENT.height - 21);
  });

  it("keeps a bubble inside the window when the request points before its edge", () => {
    const bounds = bubbleWindowBounds({ x: -400, y: -400, width: 90, height: 21 }, CONTENT);

    expect(bounds.x).toBe(CONTENT.x);
    expect(bounds.y).toBe(CONTENT.y);
  });

  it("pins a bubble wider than the window to its left edge rather than off it", () => {
    const bounds = bubbleWindowBounds({ x: 0, y: 0, width: 9000, height: 21 }, CONTENT);

    expect(bounds.x).toBe(CONTENT.x);
  });

  it("survives a window with no content area", () => {
    const bounds = bubbleWindowBounds(RECT, { x: 0, y: 0, width: 0, height: 0 });

    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
  });
});

describe("sameBubble", () => {
  it("compares text and geometry together", () => {
    const request = { text: "Example tab", rect: RECT };

    expect(sameBubble(request, { text: "Example tab", rect: { ...RECT } })).toBe(true);
    expect(sameBubble(request, { text: "Other tab", rect: { ...RECT } })).toBe(false);
    expect(sameBubble(request, { text: "Example tab", rect: { ...RECT, y: 121 } })).toBe(false);
  });

  it("treats nothing as equal only to nothing", () => {
    expect(sameBubble(null, null)).toBe(true);
    expect(sameBubble(null, { text: "Example tab", rect: RECT })).toBe(false);
  });
});

describe("IPC channels", () => {
  it("registers the bubble channels under one namespace", () => {
    const channels = [IPC_CHANNELS.bubbleShow, IPC_CHANNELS.bubbleHide];

    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) expect(channel.startsWith("bubble:")).toBe(true);
  });
});
