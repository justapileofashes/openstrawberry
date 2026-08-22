/**
 * The one surface in this application that is drawn above a page.
 *
 * Everything else the chrome shows is DOM, and DOM loses: a tab is a
 * `WebContentsView` the compositor draws over the window's own document, so the
 * chrome can only paint where no view reaches. That constraint is a good one —
 * it is why the agent panel is a real column and why a settings sheet narrows
 * the panes instead of covering them — but hover text cannot obey it. A tab
 * rail entry is 56px wide with a page immediately to its right, and there is
 * nowhere inside the chrome to put the tab's name.
 *
 * So this layer holds one small, borderless, transparent window above the
 * chrome and draws the bubble into it. Deliberately small in what it can do:
 *
 *   - It never takes focus (`focusable: false`) and never takes a click
 *     (`setIgnoreMouseEvents`), so it cannot come between the user and the page
 *     it floats over. It is a decal, not a surface.
 *   - It is positioned from the chrome's client coordinates resolved against the
 *     chrome's own content bounds, so the renderer names a place in its own
 *     document and never a place on the screen.
 *   - It shows only once the text it was given has actually been painted, so a
 *     bubble can never appear at a new position still carrying the old label.
 *   - It hides on every parent event that could invalidate its position, rather
 *     than trying to follow the window around.
 *
 * The window is created on first use and then kept: a browser hovers the rail
 * constantly, and building a renderer per hover would be visible.
 */
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { bubbleWindowBounds, sameBubble, type BubbleRequest } from "../shared/bubble.js";

/** Main to bubble window: the text to draw, tagged with the request it belongs to. */
export const BUBBLE_TEXT_CHANNEL = "bubble:text";

/** Bubble window to main: that text is on screen now. */
export const BUBBLE_PAINTED_CHANNEL = "bubble:painted";

export interface BubbleLayerOptions {
  /** The chrome window. The bubble is its child and is placed against it. */
  readonly parent: BrowserWindow;
  /**
   * Loads the bubble document. Kept out here because where the renderer is
   * served from — the dev server or the packaged bundle — is the launcher's
   * knowledge, not this layer's.
   */
  readonly load: (window: BrowserWindow) => Promise<void>;
  /** The preload for the bubble window, which is one receive-only channel wide. */
  readonly preloadPath: string;
}

export class BubbleLayer {
  private readonly parent: BrowserWindow;
  private readonly load: (window: BrowserWindow) => Promise<void>;
  private readonly preloadPath: string;

  private window: BrowserWindow | null = null;
  private loading: Promise<BrowserWindow | null> | null = null;
  private destroyed = false;

  /** The request currently being served. Null whenever the bubble is down. */
  private current: BubbleRequest | null = null;

  /** Increments per request, so a late paint acknowledgement can be ignored. */
  private sequence = 0;

  private readonly onParentChanged = (): void => this.hide();

  public constructor(options: BubbleLayerOptions) {
    this.parent = options.parent;
    this.load = options.load;
    this.preloadPath = options.preloadPath;

    /*
     * Everything that can move the chrome out from under a placed bubble. The
     * bubble is hover text with a lifetime of a second or two, so dropping it is
     * always right and always cheap — there is nothing here worth the machinery
     * of following a window through a drag.
     */
    this.parent.on("move", this.onParentChanged);
    this.parent.on("resize", this.onParentChanged);
    this.parent.on("blur", this.onParentChanged);
    this.parent.on("hide", this.onParentChanged);
    this.parent.on("minimize", this.onParentChanged);

    this.parent.once("close", () => this.destroy());

    ipcMain.on(BUBBLE_PAINTED_CHANNEL, this.onPainted);
  }

  /** Places the bubble, and shows it once its text has been painted. */
  public show(request: BubbleRequest): void {
    if (this.destroyed) return;
    if (sameBubble(this.current, request)) return;

    this.current = request;
    void this.render(request);
  }

  public hide(): void {
    this.current = null;
    // A hide that races ahead of a pending show must also invalidate it, or the
    // bubble reappears a frame later with nothing asking for it.
    this.sequence += 1;

    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    if (window.isVisible()) window.hide();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.current = null;

    ipcMain.removeListener(BUBBLE_PAINTED_CHANNEL, this.onPainted);

    this.parent.removeListener("move", this.onParentChanged);
    this.parent.removeListener("resize", this.onParentChanged);
    this.parent.removeListener("blur", this.onParentChanged);
    this.parent.removeListener("hide", this.onParentChanged);
    this.parent.removeListener("minimize", this.onParentChanged);

    const window = this.window;
    this.window = null;
    this.loading = null;

    try {
      if (window !== null && !window.isDestroyed()) window.destroy();
    } catch {
      // The parent closing takes its children with it, which is the same outcome.
    }
  }

  private async render(request: BubbleRequest): Promise<void> {
    const window = await this.ensureWindow();
    if (window === null || this.destroyed) return;

    // Awaiting the window let a newer request — or a hide — overtake this one.
    if (!sameBubble(this.current, request)) return;

    this.sequence += 1;
    const sequence = this.sequence;

    try {
      window.setBounds(bubbleWindowBounds(request.rect, this.parent.getContentBounds()));
      window.webContents.send(BUBBLE_TEXT_CHANNEL, sequence, request.text);
    } catch {
      // A window torn down mid-hover simply shows nothing.
      this.hide();
    }
  }

  /**
   * The acknowledgement half of the paint handshake.
   *
   * Bound as a field so it can be removed again, and checked against the bubble
   * window's own `WebContents`: this is an `ipcMain.on`, which any renderer in
   * the application could reach, and nothing but the bubble window may make the
   * bubble appear.
   */
  private readonly onPainted = (event: IpcMainEvent, raw: unknown): void => {
    if (this.destroyed) return;

    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    if (event.sender.id !== window.webContents.id) return;

    // Anything but the live sequence is a paint of text nobody is waiting for.
    if (raw !== this.sequence) return;
    if (this.current === null) return;

    try {
      window.showInactive();
    } catch {
      // Showing can fail while the parent is going away. Nothing to recover.
    }
  };

  private async ensureWindow(): Promise<BrowserWindow | null> {
    const existing = this.window;
    if (existing !== null && !existing.isDestroyed()) return existing;

    const loading = this.loading;
    if (loading !== null) return loading;

    const attempt = this.createWindow();
    this.loading = attempt;

    const window = await attempt;
    this.loading = null;
    this.window = window;
    return window;
  }

  private async createWindow(): Promise<BrowserWindow | null> {
    if (this.destroyed || this.parent.isDestroyed()) return null;

    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        parent: this.parent,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Hover text must never become the focused window, and must never be
        // what a click lands on.
        focusable: false,
        acceptFirstMouse: false,
        // The bubble draws its own corners; a system mask would round them twice.
        roundedCorners: false,
        // A bubble is around 21px tall. Windows will not hand out a window that
        // small unless the minimum is stated outright.
        useContentSize: true,
        width: 1,
        height: 1,
        minWidth: 1,
        minHeight: 1,
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          allowRunningInsecureContent: false,
          spellcheck: false,
          devTools: false,
          // The window is invisible most of the time, and a throttled renderer
          // acknowledges its paint late enough to be seen as a stutter.
          backgroundThrottling: false
        }
      });
    } catch {
      return null;
    }

    window.setIgnoreMouseEvents(true);

    // This document is ours and stays ours. It has no links and no reason to
    // navigate, and a bubble window that could be steered would be a page
    // drawn above every page.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());

    try {
      await this.load(window);
    } catch {
      try {
        if (!window.isDestroyed()) window.destroy();
      } catch {
        // Nothing left to clean up.
      }
      return null;
    }

    if (this.destroyed) {
      try {
        if (!window.isDestroyed()) window.destroy();
      } catch {
        // Nothing left to clean up.
      }
      return null;
    }

    return window;
  }
}
