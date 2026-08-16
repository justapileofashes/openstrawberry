import { describe, expect, it } from "vitest";
import { UpdateManager, type UpdateClient } from "./update-manager.js";

function createUpdater() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const updater: UpdateClient & { checked: number; downloaded: number; installed: number; emit: (event: string, value?: unknown) => void } = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checked: 0,
    downloaded: 0,
    installed: 0,
    checkForUpdates: async () => { updater.checked += 1; },
    downloadUpdate: async () => { updater.downloaded += 1; },
    quitAndInstall: () => { updater.installed += 1; },
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    emit: (event, value) => { for (const listener of listeners.get(event) ?? []) listener(value); }
  };
  return updater;
}

describe("UpdateManager", () => {
  it("stays safely disabled until a signed release channel is enabled", async () => {
    const updater = createUpdater();
    const states: string[] = [];
    const manager = new UpdateManager(updater, false, "0.1.0", (state) => states.push(state.status));
    manager.start();
    await manager.check();
    expect(manager.state().status).toBe("disabled");
    expect(updater.checked).toBe(0);
    expect(states).toEqual(["disabled"]);
  });

  it("requires an explicit download and install action for an available update", async () => {
    const updater = createUpdater();
    const manager = new UpdateManager(updater, true, "0.1.0", () => undefined);
    manager.start();
    updater.emit("update-available", { version: "0.2.0", releaseNotes: "Browser controls" });
    expect(manager.state()).toMatchObject({ status: "available", availableVersion: "0.2.0" });
    await manager.download();
    expect(updater.downloaded).toBe(1);
    updater.emit("download-progress", { percent: 56.6 });
    expect(manager.state()).toMatchObject({ status: "downloading", progress: 57 });
    updater.emit("update-downloaded", { version: "0.2.0" });
    expect(manager.install()).toBe(true);
    expect(updater.installed).toBe(1);
  });
});
