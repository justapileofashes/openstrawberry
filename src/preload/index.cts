/**
 * The preload bridge is the only surface the untrusted renderer can reach. It
 * exposes a narrow, explicitly enumerated capability set and never forwards raw
 * IPC, Node APIs, filesystem access, or shell access.
 *
 * This file is authored as CommonJS (.cts) on purpose: packaged sandboxed
 * Electron loads the compiled preload as .cjs. That means CommonJS syntax here,
 * not ECMAScript imports.
 */
import electron = require("electron");
import type { OpenStrawberryBridge } from "../shared/bridge.js";

const api: OpenStrawberryBridge = {
  shell: {
    platform: process.platform
  }
};

electron.contextBridge.exposeInMainWorld("openstrawberry", api);
