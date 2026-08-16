/**
 * The preload bridge is the only surface the untrusted renderer can reach. It
 * exposes a narrow, explicitly enumerated capability set and never forwards raw
 * IPC, Node APIs, filesystem access, or shell access.
 *
 * Note what is *not* here: no generic `invoke`, no channel parameter the
 * renderer controls, no `require`, no path or process handles. Each capability
 * is a named function bound to one fixed channel.
 *
 * Two constraints shape this file:
 *
 *   - It is authored as CommonJS (.cts) because packaged sandboxed Electron
 *     loads the compiled preload as .cjs.
 *   - A sandboxed preload may only require `electron`, never a local module, so
 *     the file must be self-contained. Shared contracts are therefore imported
 *     as types only, and channel names are inlined but pinned to the shared
 *     contract at compile time so the two cannot drift apart.
 */
import electron = require("electron");
import type {
  BROWSER_STATE_EVENT as BrowserStateEvent,
  IPC_CHANNELS,
  OpenStrawberryBridge,
  ShellInfo
} from "../shared/bridge.js";
import type { BrowserPaneId, BrowserSnapshot, BrowserViewport } from "../shared/browser.js";

type Channels = typeof IPC_CHANNELS;

const CHANNEL: Channels = {
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
};

const STATE_EVENT: typeof BrowserStateEvent = "browser:state";

async function snapshotCall(channel: string, payload?: unknown): Promise<BrowserSnapshot> {
  return (await electron.ipcRenderer.invoke(channel, payload)) as BrowserSnapshot;
}

const api: OpenStrawberryBridge = {
  shell: {
    platform: process.platform,
    getInfo: async (): Promise<ShellInfo> =>
      (await electron.ipcRenderer.invoke(CHANNEL.shellInfo)) as ShellInfo
  },
  browser: {
    getSnapshot: async () => snapshotCall(CHANNEL.browserSnapshot),
    createTab: async (paneId: BrowserPaneId, url?: string) =>
      snapshotCall(CHANNEL.browserCreateTab, { paneId, url }),
    closeTab: async (tabId: string) => snapshotCall(CHANNEL.browserCloseTab, { tabId }),
    activateTab: async (tabId: string) => snapshotCall(CHANNEL.browserActivateTab, { tabId }),
    moveTab: async (tabId: string, paneId: BrowserPaneId) =>
      snapshotCall(CHANNEL.browserMoveTab, { tabId, paneId }),
    navigate: async (tabId: string, address: string) =>
      snapshotCall(CHANNEL.browserNavigate, { tabId, address }),
    back: async (tabId: string) => snapshotCall(CHANNEL.browserBack, { tabId }),
    forward: async (tabId: string) => snapshotCall(CHANNEL.browserForward, { tabId }),
    reload: async (tabId: string) => snapshotCall(CHANNEL.browserReload, { tabId }),
    stop: async (tabId: string) => snapshotCall(CHANNEL.browserStop, { tabId }),
    setViewport: async (paneId: BrowserPaneId, viewport: BrowserViewport) =>
      snapshotCall(CHANNEL.browserSetViewport, { paneId, viewport }),
    setSplitEnabled: async (enabled: boolean) =>
      snapshotCall(CHANNEL.browserSetSplit, { enabled }),
    setActivePane: async (paneId: BrowserPaneId) =>
      snapshotCall(CHANNEL.browserSetActivePane, { paneId }),
    onState: (listener: (snapshot: BrowserSnapshot) => void): (() => void) => {
      // The raw IpcRendererEvent is deliberately not passed through; the
      // renderer receives only the snapshot payload.
      const handler = (_event: unknown, snapshot: BrowserSnapshot): void => listener(snapshot);
      electron.ipcRenderer.on(STATE_EVENT, handler);
      return () => electron.ipcRenderer.removeListener(STATE_EVENT, handler);
    }
  }
};

electron.contextBridge.exposeInMainWorld("openstrawberry", api);
