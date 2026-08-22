/**
 * Acting on a page, as input rather than as script.
 *
 * Every other browser that lets a model click does it by evaluating something in
 * the page: a selector is resolved and `.click()` is called, or a snippet is
 * built around whatever string the model produced. This module does neither.
 * An action names a reference; the reference resolves, in this process, to a
 * rectangle this process captured; and what is dispatched is a real mouse or key
 * event at that rectangle's centre.
 *
 * Three things follow from that, and the third is the reason for it:
 *
 *   1. **The events are trusted.** `isTrusted` is true on the other side, so a
 *      site that gates on it - which is most payment and authentication flows -
 *      behaves for an agent exactly as it does for a person. A synthetic
 *      `.click()` is visibly not a person to any page that looks.
 *
 *   2. **Framework state updates.** Typing produces `keydown`, `keypress`,
 *      `input`, and `keyup` in the order a keyboard produces them, so a React or
 *      Vue controlled input takes the value. Assigning `.value` from a script
 *      fires nothing and leaves the framework holding the old string, which is
 *      the classic way an automated form fill silently submits blank fields.
 *
 *   3. **No string an agent produced is ever evaluated.** There is no selector
 *      argument, no expression argument, and no code path from a tool call to
 *      `executeJavaScript` at all - the one script this feature owns is the
 *      constant capture in `page-snapshot.ts`, which takes no input. That is
 *      what keeps the closed-set rule in `shared/browser-tools.ts` a property of
 *      the code rather than a promise about escaping.
 *
 * The cost is that an element must be on screen to be acted on, because an
 * element that is not drawn has no coordinates to aim at. That is handled by
 * refusing, and by saying so, rather than by scrolling something into view with
 * a script and hoping the reference still means what it did.
 */
import type { PressableKey } from "../shared/browser-tools.js";

/* ------------------------------------------------------------------------- */
/* The events this module will send                                           */
/* ------------------------------------------------------------------------- */

/**
 * Declared here rather than imported from Electron, so this module can be
 * exercised against a plain object and so the set of events it is capable of
 * sending is readable in one place. A real `WebContents` satisfies it.
 */
export interface InputContentsPort {
  readonly sendInputEvent: (event: DispatchedInputEvent) => void;
  readonly focus: () => void;
  readonly isDestroyed?: () => boolean;
}

/**
 * The only modifiers this module ever holds down.
 *
 * Two, for the one chord it sends: select-everything before replacing a field's
 * contents. Nothing here reaches for Shift, Alt, or a combination, because an
 * agent that needs a modifier is an agent reaching past the page it was granted.
 */
export type InputModifier = "control" | "meta";

export type DispatchedInputEvent =
  | {
      readonly type: "mouseMove" | "mouseDown" | "mouseUp";
      readonly x: number;
      readonly y: number;
      readonly button?: "left";
      readonly clickCount?: number;
      readonly modifiers?: InputModifier[];
    }
  | {
      readonly type: "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly canScroll: true;
    }
  | {
      readonly type: "keyDown" | "keyUp" | "char";
      readonly keyCode: string;
      readonly modifiers?: InputModifier[];
    };

/* ------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* ------------------------------------------------------------------------- */

/** How much text one `type` or `fill` may enter. */
export const MAX_TYPE_LENGTH = 2000;

/** How many notches one `scroll` may travel, and how far a notch is. */
export const MAX_SCROLL_AMOUNT = 10;
const SCROLL_NOTCH_PX = 100;

/** Long enough for a renderer to process the previous event, short enough to be fast. */
const EVENT_GAP_MS = 12;
const CLICK_GAP_MS = 30;

/**
 * What Electron's accelerator vocabulary calls each key the contract offers.
 *
 * The contract uses DOM key names, because that is what a model has seen
 * everywhere else and `ArrowDown` is what it will write. Electron's input events
 * take accelerator names, where the same key is `Down`. The translation is one
 * table rather than a rule, so a key that is added to the contract without being
 * translated here is a compile error.
 */
const ELECTRON_KEY_CODES: Readonly<Record<PressableKey, string>> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown"
};

/** The platform's "select everything in this field" chord. */
const SELECT_ALL_MODIFIER: InputModifier = process.platform === "darwin" ? "meta" : "control";

/* ------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* ------------------------------------------------------------------------- */

export interface DispatchOptions {
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A point inside the element, as an integer, because an event takes integers. */
export function centreOf(rect: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): { readonly x: number; readonly y: number } {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2)
  };
}

/**
 * Moves the pointer somewhere and leaves it there.
 *
 * Sent before every click as well, because a page that reveals its real control
 * on hover - a menu, a row's action buttons - has not drawn it yet when a click
 * arrives cold, and the click lands on whatever was underneath.
 */
export async function hoverAt(
  contents: InputContentsPort,
  point: { readonly x: number; readonly y: number },
  options: DispatchOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  await sleep(EVENT_GAP_MS);
}

export async function clickAt(
  contents: InputContentsPort,
  point: { readonly x: number; readonly y: number },
  options: DispatchOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;

  /*
   * The window has to be the one receiving input for these to land. Focusing the
   * contents is the same act the user performs by clicking the page, and it is
   * scoped to the view rather than raising the window, so it cannot pull the
   * machine's focus away from whatever else they are doing.
   *
   * It can still take focus away from the address bar of this window, though,
   * which is a real cost: a user typing there while an agent acts loses the rest
   * of what they were typing. It is accepted rather than solved, because there is
   * no way to deliver a keystroke to a view that is not receiving keystrokes, and
   * the once-per-run consent is where the user agrees to an agent doing this at
   * all.
   */
  contents.focus();

  await hoverAt(contents, point, options);
  contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(EVENT_GAP_MS);
  contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await sleep(CLICK_GAP_MS);
}

/**
 * Types text one character at a time.
 *
 * `keyDown`, `char`, `keyUp` for each, rather than a single `char`, because that
 * is the sequence a keyboard produces and the sequence a page's own handlers are
 * written against. A page that filters input on `keydown` - a phone number field
 * refusing letters, a search box opening a suggestion list - only behaves
 * correctly if the events it filters on actually arrive.
 */
export async function typeText(
  contents: InputContentsPort,
  text: string,
  options: DispatchOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;

  for (const character of text.slice(0, MAX_TYPE_LENGTH)) {
    contents.sendInputEvent({ type: "keyDown", keyCode: character });
    contents.sendInputEvent({ type: "char", keyCode: character });
    contents.sendInputEvent({ type: "keyUp", keyCode: character });
    await sleep(EVENT_GAP_MS);
  }
}

export async function pressKey(
  contents: InputContentsPort,
  key: PressableKey,
  options: DispatchOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const keyCode = ELECTRON_KEY_CODES[key];

  contents.sendInputEvent({ type: "keyDown", keyCode });
  contents.sendInputEvent({ type: "keyUp", keyCode });
  await sleep(CLICK_GAP_MS);
}

/** Empties a field the way a person does, so the page sees the deletion happen. */
export async function clearField(
  contents: InputContentsPort,
  options: DispatchOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;

  contents.sendInputEvent({ type: "keyDown", keyCode: "a", modifiers: [SELECT_ALL_MODIFIER] });
  contents.sendInputEvent({ type: "keyUp", keyCode: "a", modifiers: [SELECT_ALL_MODIFIER] });
  await sleep(EVENT_GAP_MS);

  contents.sendInputEvent({ type: "keyDown", keyCode: "Delete" });
  contents.sendInputEvent({ type: "keyUp", keyCode: "Delete" });
  await sleep(EVENT_GAP_MS);
}

export async function scrollBy(
  contents: InputContentsPort,
  point: { readonly x: number; readonly y: number },
  direction: "up" | "down" | "left" | "right",
  amount: number,
  options: DispatchOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const notches = Math.max(1, Math.min(MAX_SCROLL_AMOUNT, Math.round(amount)));
  const distance = notches * SCROLL_NOTCH_PX;

  contents.sendInputEvent({
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    // A wheel scrolls the page down by sending a negative delta, which is the
    // opposite of how anyone says it, so the translation happens once, here.
    deltaX: direction === "left" ? distance : direction === "right" ? -distance : 0,
    deltaY: direction === "up" ? distance : direction === "down" ? -distance : 0,
    canScroll: true
  });

  await sleep(CLICK_GAP_MS);
}

/**
 * Chooses an option in a native `<select>` with the keyboard.
 *
 * Clicking is not available: the popup a native select opens is drawn by the
 * operating system, outside the page's coordinate space, so there is nothing at
 * a coordinate to aim at. Focusing the control and walking to the option with
 * arrow keys is what a person without a mouse does, and it produces the same
 * `change` event the page is listening for.
 *
 * The step count is an integer this process derived from its own capture. It is
 * bounded by the option cap, so a hostile page cannot turn a selection into
 * thousands of keystrokes.
 */
export async function selectOption(
  contents: InputContentsPort,
  currentIndex: number,
  targetIndex: number,
  options: DispatchOptions = {}
): Promise<void> {
  const steps = targetIndex - currentIndex;
  const key: PressableKey = steps >= 0 ? "ArrowDown" : "ArrowUp";

  for (let taken = 0; taken < Math.abs(steps); taken += 1) {
    await pressKey(contents, key, options);
  }
}
