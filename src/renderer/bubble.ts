/**
 * The bubble window's entire renderer.
 *
 * It owns one element and one rule: the text it is given goes on screen as
 * *text*. A rail bubble carries a tab's title, which is whatever a page decided
 * to call itself, so `textContent` here is not a convenience — it is the reason
 * a hostile title cannot become markup in a window that floats above every page.
 *
 * The acknowledgement is the other half. The trusted process keeps this window
 * hidden until the frame carrying the new text has been composited, so a bubble
 * never appears at one control still showing another's name.
 */
import "./styles.css";

interface BubbleWindowBridge {
  readonly onText: (listener: (sequence: number, text: string) => void) => void;
  readonly painted: (sequence: number) => void;
}

declare global {
  interface Window {
    readonly __osBubble?: BubbleWindowBridge;
  }
}

const element = document.getElementById("bubble");
const bridge = window.__osBubble;

if (element !== null && bridge !== undefined) {
  bridge.onText((sequence, text) => {
    element.textContent = text;

    /*
     * Two frames, not one. The first is scheduled before the style and layout
     * this assignment invalidated have been recalculated; the second runs after
     * the frame carrying them has been drawn, which is the thing being reported.
     */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => bridge.painted(sequence));
    });
  });
}
