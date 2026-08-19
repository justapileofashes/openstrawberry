import { describe, expect, it } from "vitest";
import {
  actionsFor,
  describeProgress,
  forDisplay,
  formatBytes,
  progressFraction
} from "./download-chrome.js";
import type { DownloadItem } from "../shared/downloads.js";

function itemWith(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: "download-1",
    fileName: "report.pdf",
    host: "example.com",
    state: "progressing",
    receivedBytes: 512,
    totalBytes: 2048,
    canResume: false,
    directoryLabel: "Downloads",
    startedAt: 1_700_000_000_000,
    endedAt: null,
    ...overrides
  };
}

describe("formatBytes", () => {
  it("uses binary units, matching the file manager the file lands in", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("drops the decimal once it is noise", () => {
    expect(formatBytes(1024 * 15)).toBe("15 KB");
    expect(formatBytes(1024 * 1024 * 42)).toBe("42 MB");
  });

  it("treats nonsense as zero rather than rendering it", () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatBytes(value)).toBe("0 B");
    }
  });
});

describe("describeProgress", () => {
  it("reads as received of total while running", () => {
    expect(describeProgress(itemWith())).toBe("512 B of 2.0 KB");
  });

  it("marks a paused transfer without losing the counts", () => {
    expect(describeProgress(itemWith({ state: "paused" }))).toBe("512 B of 2.0 KB, paused");
  });

  it("reports the received count when the server declared no length", () => {
    // "0%" would be a lie; the received count is what is actually known.
    expect(describeProgress(itemWith({ totalBytes: 0 }))).toBe("512 B");
    expect(describeProgress(itemWith({ totalBytes: 0, state: "paused" }))).toBe("512 B, paused");
  });

  it("shows the final size once complete", () => {
    expect(describeProgress(itemWith({ state: "completed", receivedBytes: 2048 }))).toBe("2.0 KB");
  });

  it("distinguishes a cancellation from a failure", () => {
    expect(describeProgress(itemWith({ state: "cancelled" }))).toBe("Cancelled");
    expect(describeProgress(itemWith({ state: "interrupted" }))).toBe("Failed");
  });
});

describe("progressFraction", () => {
  it("measures against the declared total", () => {
    expect(progressFraction(itemWith({ receivedBytes: 1024, totalBytes: 2048 }))).toBe(0.5);
  });

  it("is null without a total, so the bar can read as indeterminate", () => {
    expect(progressFraction(itemWith({ totalBytes: 0 }))).toBeNull();
  });

  it("is full for a completed download and null for a failed one", () => {
    expect(progressFraction(itemWith({ state: "completed" }))).toBe(1);
    expect(progressFraction(itemWith({ state: "interrupted" }))).toBeNull();
    expect(progressFraction(itemWith({ state: "cancelled" }))).toBeNull();
  });

  it("clamps a server that over-reports", () => {
    expect(progressFraction(itemWith({ receivedBytes: 9999, totalBytes: 100 }))).toBe(1);
  });
});

describe("actionsFor", () => {
  it("offers pause and cancel while running", () => {
    expect(actionsFor(itemWith())).toEqual({
      canPause: true,
      canResume: false,
      canCancel: true,
      canReveal: false
    });
  });

  it("offers resume only when the transfer can actually be resumed", () => {
    expect(actionsFor(itemWith({ state: "paused", canResume: true })).canResume).toBe(true);
    // Paused but not resumable: the button would fail, so it is not offered.
    expect(actionsFor(itemWith({ state: "paused", canResume: false })).canResume).toBe(false);
  });

  it("offers reveal only for a completed download", () => {
    expect(actionsFor(itemWith({ state: "completed" })).canReveal).toBe(true);
    for (const state of ["progressing", "paused", "cancelled", "interrupted"] as const) {
      expect(actionsFor(itemWith({ state })).canReveal).toBe(false);
    }
  });

  it("offers nothing to cancel once finished", () => {
    for (const state of ["completed", "cancelled", "interrupted"] as const) {
      expect(actionsFor(itemWith({ state })).canCancel).toBe(false);
    }
  });
});

describe("forDisplay", () => {
  it("lists the newest first", () => {
    const items = [
      itemWith({ id: "download-1" }),
      itemWith({ id: "download-2" }),
      itemWith({ id: "download-3" })
    ];

    expect(forDisplay(items).map((item) => item.id)).toEqual([
      "download-3",
      "download-2",
      "download-1"
    ]);
  });

  it("does not mutate what it was given", () => {
    const items = [itemWith({ id: "download-1" }), itemWith({ id: "download-2" })];
    forDisplay(items);
    expect(items.map((item) => item.id)).toEqual(["download-1", "download-2"]);
  });
});
