import type { UpdateSnapshot } from "../shared/update.js";

type UpdateEvent = "checking-for-update" | "update-available" | "update-not-available" | "download-progress" | "update-downloaded" | "error";

export type UpdateClient = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => void;
  on: (event: UpdateEvent, listener: (...args: unknown[]) => void) => unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function releaseDetails(value: unknown): Pick<UpdateSnapshot, "availableVersion" | "releaseNotes"> {
  const record = asRecord(value);
  if (!record) return {};
  return {
    availableVersion: typeof record.version === "string" ? record.version : undefined,
    releaseNotes: typeof record.releaseNotes === "string" ? record.releaseNotes : undefined
  };
}

function progressPercent(value: unknown): number | undefined {
  const record = asRecord(value);
  const percent = record?.percent;
  return typeof percent === "number" && Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : undefined;
}

export class UpdateManager {
  private snapshot: UpdateSnapshot;
  private started = false;

  public constructor(private readonly updater: UpdateClient, private readonly enabled: boolean, currentVersion: string, private readonly publish: (snapshot: UpdateSnapshot) => void) {
    this.snapshot = enabled
      ? { status: "idle", currentVersion, message: "Check for a signed OpenStrawberry update." }
      : { status: "disabled", currentVersion, message: "In-app updates activate after OpenStrawberry publishes its first signed stable release." };
  }

  public state(): UpdateSnapshot { return this.snapshot; }

  public start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) { this.publish(this.snapshot); return; }
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.on("checking-for-update", () => this.set({ status: "checking", message: "Checking for a signed update…" }));
    this.updater.on("update-available", (info) => this.set({ status: "available", ...releaseDetails(info), message: "A signed update is ready to download." }));
    this.updater.on("update-not-available", () => this.set({ status: "idle", message: "OpenStrawberry is up to date." }));
    this.updater.on("download-progress", (progress) => this.set({ status: "downloading", progress: progressPercent(progress), message: "Downloading the signed update…" }));
    this.updater.on("update-downloaded", (info) => this.set({ status: "downloaded", ...releaseDetails(info), progress: 100, message: "Update downloaded. Restart to install it." }));
    this.updater.on("error", () => this.set({ status: "error", message: "The update check could not finish. Try again later." }));
    void this.check();
  }

  public async check(): Promise<UpdateSnapshot> {
    if (!this.enabled) return this.snapshot;
    this.set({ status: "checking", message: "Checking for a signed update…" });
    try { await this.updater.checkForUpdates(); } catch { this.set({ status: "error", message: "The update check could not finish. Try again later." }); }
    return this.snapshot;
  }

  public async download(): Promise<UpdateSnapshot> {
    if (!this.enabled || this.snapshot.status !== "available") return this.snapshot;
    this.set({ status: "downloading", progress: 0, message: "Downloading the signed update…" });
    try { await this.updater.downloadUpdate(); } catch { this.set({ status: "error", message: "The update download could not finish. Try again later." }); }
    return this.snapshot;
  }

  public install(): boolean {
    if (!this.enabled || this.snapshot.status !== "downloaded") return false;
    this.updater.quitAndInstall();
    return true;
  }

  private set(next: Omit<UpdateSnapshot, "currentVersion">): void {
    this.snapshot = { ...this.snapshot, ...next, currentVersion: this.snapshot.currentVersion };
    this.publish(this.snapshot);
  }
}
