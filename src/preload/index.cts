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
import type { IPC_CHANNELS, OpenStrawberryBridge, ShellInfo } from "../shared/bridge.js";

const SHELL_INFO_CHANNEL: typeof IPC_CHANNELS.shellInfo = "shell:info";

const api: OpenStrawberryBridge = {
  shell: {
    platform: process.platform,
    getInfo: async (): Promise<ShellInfo> =>
      (await electron.ipcRenderer.invoke(SHELL_INFO_CHANNEL)) as ShellInfo
  }
};

electron.contextBridge.exposeInMainWorld("openstrawberry", api);
