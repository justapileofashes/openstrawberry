import type { OpenStrawberryBridge } from "../shared/bridge.js";

declare global {
  interface Window {
    readonly openstrawberry: OpenStrawberryBridge;
  }
}

export {};
