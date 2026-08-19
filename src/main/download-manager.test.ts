import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadManager, uniqueFileName } from "./download-manager.js";
import type { DownloadSnapshot } from "../shared/downloads.js";

/**
 * A stand-in for Electron's DownloadItem.
 *
 * Only the methods the manager calls, plus the two event names it subscribes
 * to, so a test drives a download the way Chromium would.
 */
class FakeDownloadItem {
  public savePath = "";
  public cancelled = false;
  public paused = false;
  public resumed = false;

  private readonly listeners = new Map<string, ((event: unknown, state: string) => void)[]>();

  public constructor(
    private readonly fileName: string,
    private readonly url = "https://files.example.com/a",
    private received = 0,
    private total = 2048,
    private readonly resumable = true
  ) {}

  public getFilename(): string {
    return this.fileName;
  }
  public getURL(): string {
    return this.url;
  }
  public getReceivedBytes(): number {
    return this.received;
  }
  public getTotalBytes(): number {
    return this.total;
  }
  public canResume(): boolean {
    return this.resumable;
  }
  public isPaused(): boolean {
    return this.paused;
  }
  public setSavePath(path: string): void {
    this.savePath = path;
  }
  public pause(): void {
    this.paused = true;
  }
  public resume(): void {
    this.resumed = true;
    this.paused = false;
  }
  public cancel(): void {
    this.cancelled = true;
  }

  public on(event: string, handler: (event: unknown, state: string) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(handler);
    this.listeners.set(event, existing);
    return this;
  }

  /** Drives progress the way Chromium's `updated` event does. */
  public progress(received: number): void {
    this.received = received;
    for (const handler of this.listeners.get("updated") ?? []) handler({}, "progressing");
  }

  public finish(state: "completed" | "cancelled" | "interrupted"): void {
    if (state === "completed") this.received = this.total;
    for (const handler of this.listeners.get("done") ?? []) handler({}, state);
  }
}

let directory = "";
let downloadDir = "";
let statePath = "";
let published: DownloadSnapshot[] = [];
let revealed: string[] = [];
let startDownload: (item: FakeDownloadItem) => void;

function build(): DownloadManager {
  let handler: ((event: unknown, item: unknown, contents: unknown) => void) | null = null;

  const session = {
    on: (event: string, listener: (event: unknown, item: unknown, contents: unknown) => void) => {
      if (event === "will-download") handler = listener;
      return session;
    }
  };

  const manager = new DownloadManager({
    session: session as never,
    downloadDir,
    directoryLabel: "Downloads",
    statePath,
    publish: (snapshot: DownloadSnapshot) => published.push(snapshot),
    reveal: (path: string) => revealed.push(path)
  });

  startDownload = (item) => handler?.({}, item, null);
  return manager;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-downloads-"));
  downloadDir = join(directory, "Downloads");
  statePath = join(directory, "downloads.json");
  published = [];
  revealed = [];
  // The destination must exist for collision checks to be meaningful.
  mkdirSync(downloadDir, { recursive: true });
});

describe("uniqueFileName", () => {
  it("keeps a free name", () => {
    expect(uniqueFileName("/d", "a.txt", () => false)).toBe("a.txt");
  });

  it("suffixes a taken name the way Chromium does", () => {
    // Built with `join` so the predicate matches on every platform's separator.
    const taken = new Set([join("/d", "a.txt"), join("/d", "a (1).txt")]);
    expect(uniqueFileName("/d", "a.txt", (path) => taken.has(path))).toBe("a (2).txt");
  });

  it("suffixes before the extension, so the file still opens correctly", () => {
    const result = uniqueFileName(
      "/d",
      "report.tar.gz",
      (path) => path === join("/d", "report.tar.gz")
    );
    expect(result).toBe("report.tar (1).gz");
  });

  it("handles a name with no extension", () => {
    expect(uniqueFileName("/d", "LICENSE", (path) => path === join("/d", "LICENSE"))).toBe(
      "LICENSE (1)"
    );
  });

  it("terminates even when everything is taken", () => {
    const result = uniqueFileName("/d", "a.txt", () => true);
    expect(result).toMatch(/^a-\d+\.txt$/u);
  });
});

describe("DownloadManager", () => {
  it("adopts a download and reports it progressing", () => {
    const manager = build();
    const item = new FakeDownloadItem("report.pdf");

    startDownload(item);

    const snapshot = manager.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.fileName).toBe("report.pdf");
    expect(snapshot.items[0]?.host).toBe("files.example.com");
    expect(snapshot.items[0]?.state).toBe("progressing");
    expect(snapshot.hasActive).toBe(true);
  });

  it("writes into the download directory whatever the server suggested", () => {
    // The security property: a hostile Content-Disposition cannot place a file
    // outside the destination.
    const manager = build();

    const cases = [
      { suggested: "../../../evil.exe", expected: "evil.exe" },
      { suggested: "..\\..\\evil.exe", expected: "evil.exe" },
      { suggested: "/etc/passwd", expected: "etc passwd" }
    ];

    for (const { suggested, expected } of cases) {
      const item = new FakeDownloadItem(suggested);
      startDownload(item);

      // Stays inside the destination, and carries none of the traversal debris.
      expect(item.savePath.startsWith(downloadDir)).toBe(true);
      expect(item.savePath).toBe(join(downloadDir, expected));
    }

    // And the renderer is told a name, never the location.
    for (const entry of manager.snapshot().items) {
      expect(entry.fileName).not.toContain("/");
      expect(entry.fileName).not.toContain("\\");
      expect(JSON.stringify(entry)).not.toContain(downloadDir);
    }
  });

  it("does not overwrite a file that is already there", () => {
    writeFileSync(join(downloadDir, "report.pdf"), "existing");
    build();

    const item = new FakeDownloadItem("report.pdf");
    startDownload(item);

    expect(item.savePath).toBe(join(downloadDir, "report (1).pdf"));
    expect(readFileSync(join(downloadDir, "report.pdf"), "utf8")).toBe("existing");
  });

  it("tracks progress and completion", () => {
    const manager = build();
    const item = new FakeDownloadItem("a.bin");
    startDownload(item);

    item.progress(1024);
    expect(manager.snapshot().items[0]?.receivedBytes).toBe(1024);

    item.finish("completed");
    const done = manager.snapshot().items[0];
    expect(done?.state).toBe("completed");
    expect(done?.endedAt).not.toBeNull();
    expect(done?.canResume).toBe(false);
    expect(manager.snapshot().hasActive).toBe(false);
  });

  it("distinguishes a cancelled download from an interrupted one", () => {
    const manager = build();

    const cancelled = new FakeDownloadItem("a.bin");
    startDownload(cancelled);
    cancelled.finish("cancelled");

    const broken = new FakeDownloadItem("b.bin");
    startDownload(broken);
    broken.finish("interrupted");

    const states = manager.snapshot().items.map((entry) => entry.state);
    expect(states).toEqual(["cancelled", "interrupted"]);
  });

  it("pauses, resumes, and cancels through the live handle", () => {
    const manager = build();
    const item = new FakeDownloadItem("a.bin");
    startDownload(item);
    const id = manager.snapshot().items[0]?.id ?? "";

    manager.pause(id);
    expect(item.paused).toBe(true);
    expect(manager.snapshot().items[0]?.state).toBe("paused");

    manager.resume(id);
    expect(item.resumed).toBe(true);

    manager.cancel(id);
    expect(item.cancelled).toBe(true);
  });

  it("ignores commands naming a download that does not exist", () => {
    const manager = build();
    for (const call of ["pause", "resume", "cancel", "showInFolder"] as const) {
      expect(() => manager[call]("download-999")).not.toThrow();
    }
    expect(revealed).toEqual([]);
  });

  it("reveals only a completed file, and only its own path", () => {
    const manager = build();
    const item = new FakeDownloadItem("a.bin");
    startDownload(item);
    const id = manager.snapshot().items[0]?.id ?? "";

    // Still in flight: nothing to show.
    manager.showInFolder(id);
    expect(revealed).toEqual([]);

    item.finish("completed");
    // The file has to actually be there.
    writeFileSync(item.savePath, "contents");

    manager.showInFolder(id);
    expect(revealed).toEqual([join(downloadDir, "a.bin")]);
  });

  it("does not reveal a file that has since been moved away", () => {
    const manager = build();
    const item = new FakeDownloadItem("a.bin");
    startDownload(item);
    item.finish("completed");

    // Never written, so the path does not resolve.
    manager.showInFolder(manager.snapshot().items[0]?.id ?? "");
    expect(revealed).toEqual([]);
  });

  it("clears finished entries without touching the files", () => {
    const manager = build();

    const done = new FakeDownloadItem("done.bin");
    startDownload(done);
    done.finish("completed");
    writeFileSync(done.savePath, "contents");

    const active = new FakeDownloadItem("active.bin");
    startDownload(active);

    manager.clearFinished();

    const remaining = manager.snapshot().items;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.fileName).toBe("active.bin");
    // The list was cleared. The file was not.
    expect(existsSync(done.savePath)).toBe(true);
  });

  it("persists finished downloads and restores them as non-live", () => {
    const first = build();
    const item = new FakeDownloadItem("report.pdf");
    startDownload(item);
    item.finish("completed");
    first.destroy();

    const second = build();
    second.restore();

    const restored = second.snapshot().items;
    expect(restored).toHaveLength(1);
    expect(restored[0]?.fileName).toBe("report.pdf");
    expect(restored[0]?.state).toBe("completed");
    expect(second.snapshot().hasActive).toBe(false);
  });

  it("cannot reveal a restored download, whose location this process never knew", () => {
    const first = build();
    const item = new FakeDownloadItem("report.pdf");
    startDownload(item);
    item.finish("completed");
    writeFileSync(item.savePath, "contents");
    first.destroy();

    const second = build();
    second.restore();
    second.showInFolder(second.snapshot().items[0]?.id ?? "");

    // Restored history carries no path, so there is nothing truthful to show.
    expect(revealed).toEqual([]);
  });

  it("mints ids past those already restored", () => {
    const first = build();
    const item = new FakeDownloadItem("a.bin");
    startDownload(item);
    item.finish("completed");
    const firstId = first.snapshot().items[0]?.id ?? "";
    first.destroy();

    const second = build();
    second.restore();
    startDownload(new FakeDownloadItem("b.bin"));

    const ids = second.snapshot().items.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(firstId);
  });

  it("publishes on every change so the panel never polls", () => {
    build();
    const item = new FakeDownloadItem("a.bin");

    startDownload(item);
    const afterStart = published.length;
    item.progress(512);
    item.finish("completed");

    expect(afterStart).toBeGreaterThan(0);
    expect(published.length).toBeGreaterThan(afterStart);
  });

  it("is safe to destroy twice and stops publishing afterwards", () => {
    const manager = build();
    startDownload(new FakeDownloadItem("a.bin"));

    manager.destroy();
    const afterDestroy = published.length;
    manager.destroy();

    expect(published.length).toBe(afterDestroy);
  });

  it("refuses a download that arrives after teardown", () => {
    const manager = build();
    manager.destroy();

    const late = new FakeDownloadItem("a.bin");
    startDownload(late);

    expect(late.cancelled).toBe(true);
    expect(manager.snapshot().items).toHaveLength(0);
  });

  it("tolerates a state file that was damaged on disk", () => {
    writeFileSync(statePath, "{ not json at all");
    const manager = build();

    expect(() => manager.restore()).not.toThrow();
    expect(manager.snapshot().items).toEqual([]);
  });

  it("survives a handle whose methods throw after release", () => {
    const manager = build();
    const item = new FakeDownloadItem("a.bin");
    startDownload(item);
    const id = manager.snapshot().items[0]?.id ?? "";

    item.finish("completed");
    vi.spyOn(item, "getReceivedBytes").mockImplementation(() => {
      throw new Error("released");
    });

    expect(() => manager.pause(id)).not.toThrow();
    expect(() => manager.resume(id)).not.toThrow();
  });
});
