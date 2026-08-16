/**
 * The capability contract between the trusted main process and the untrusted
 * renderer. The preload implements exactly this shape and nothing more.
 *
 * Nothing on this interface may carry raw credentials, browser passwords,
 * session tokens, or absolute local paths.
 */

import type {
  BrowserPaneId,
  BrowserSnapshot,
  BrowserViewport
} from "./browser.js";

/** Channel names, shared so both sides of the boundary cannot drift apart. */
export const IPC_CHANNELS = {
  shellInfo: "shell:info",
  browserSnapshot: "browser:snapshot",
  browserCreateTab: "browser:create-tab",
  browserCloseTab: "browser:close-tab",
  browserActivateTab: "browser:activate-tab",
  browserMoveTab: "browser:move-tab",
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  browserReload: "browser:reload",
  browserStop: "browser:stop",
  browserSetViewport: "browser:set-viewport",
  browserSetSplit: "browser:set-split",
  browserSetActivePane: "browser:set-active-pane"
} as const;

/** Push channel the main process uses to broadcast browser state changes. */
export const BROWSER_STATE_EVENT = "browser:state";

/** Non-secret facts about the running application. */
export interface ShellInfo {
  readonly platform: string;
  readonly appVersion: string;
  /**
   * False until signed artifacts and verified update metadata exist. The chrome
   * uses this to keep download affordances and the update channel inert.
   */
  readonly releaseReady: boolean;
  readonly updatesEnabled: boolean;
}

/**
 * The browser capability surface.
 *
 * Every call returns a snapshot — bounded display metadata only. The renderer
 * never receives a view handle, a WebContents id, or a local path.
 */
export interface BrowserBridge {
  readonly getSnapshot: () => Promise<BrowserSnapshot>;
  readonly createTab: (paneId: BrowserPaneId, url?: string) => Promise<BrowserSnapshot>;
  readonly closeTab: (tabId: string) => Promise<BrowserSnapshot>;
  readonly activateTab: (tabId: string) => Promise<BrowserSnapshot>;
  readonly moveTab: (tabId: string, paneId: BrowserPaneId) => Promise<BrowserSnapshot>;
  readonly navigate: (tabId: string, address: string) => Promise<BrowserSnapshot>;
  readonly back: (tabId: string) => Promise<BrowserSnapshot>;
  readonly forward: (tabId: string) => Promise<BrowserSnapshot>;
  readonly reload: (tabId: string) => Promise<BrowserSnapshot>;
  readonly stop: (tabId: string) => Promise<BrowserSnapshot>;
  readonly setViewport: (
    paneId: BrowserPaneId,
    viewport: BrowserViewport
  ) => Promise<BrowserSnapshot>;
  readonly setSplitEnabled: (enabled: boolean) => Promise<BrowserSnapshot>;
  readonly setActivePane: (paneId: BrowserPaneId) => Promise<BrowserSnapshot>;
  /** Subscribes to pushed state. Returns an unsubscribe function. */
  readonly onState: (listener: (snapshot: BrowserSnapshot) => void) => () => void;
}

export interface OpenStrawberryBridge {
  readonly shell: {
    /** Available synchronously so first paint does not wait on IPC. */
    readonly platform: string;
    readonly getInfo: () => Promise<ShellInfo>;
  };
  readonly browser: BrowserBridge;
}
