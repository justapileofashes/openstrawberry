/**
 * The only thing the bubble window can reach.
 *
 * The window that draws hover text above the pages has no state, no history, and
 * nothing to ask for. It is handed a string and it says when that string is on
 * screen, and this preload is exactly those two moves: one listener and one
 * acknowledgement, neither carrying anything else.
 *
 * Note what is not here, for the same reasons as the main bridge: no generic
 * `invoke`, no channel the page chooses, no `require`, no filesystem, no process
 * handle. A sandboxed preload may only require `electron`, so this file is
 * self-contained and the channel names are inlined.
 */
import electron = require("electron");

const BUBBLE_TEXT_CHANNEL = "bubble:text";
const BUBBLE_PAINTED_CHANNEL = "bubble:painted";

electron.contextBridge.exposeInMainWorld("__osBubble", {
  /**
   * Receives the text to draw. `sequence` identifies the request it belongs to
   * and is handed straight back, so a slow paint cannot make a bubble appear
   * that something newer has already replaced.
   */
  onText: (listener: (sequence: number, text: string) => void): void => {
    electron.ipcRenderer.on(
      BUBBLE_TEXT_CHANNEL,
      (_event: unknown, sequence: unknown, text: unknown) => {
        if (typeof sequence !== "number" || typeof text !== "string") return;
        listener(sequence, text);
      }
    );
  },
  painted: (sequence: number): void => {
    electron.ipcRenderer.send(BUBBLE_PAINTED_CHANNEL, sequence);
  }
});
