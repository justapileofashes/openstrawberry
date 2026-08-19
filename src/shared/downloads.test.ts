import { describe, expect, it } from "vitest";
import {
  boundDownloads,
  DOWNLOAD_STATE_VERSION,
  emptyDownloadSnapshot,
  isTerminalDownloadState,
  MAX_DOWNLOADS_RETAINED,
  MAX_FILE_NAME_LENGTH,
  parseDownloadIdPayload,
  parsePersistedDownloads,
  safeFileName,
  toPersistedDownloads,
  type DownloadItem,
  type DownloadState
} from "./downloads.js";

/** Escapes are used throughout so the hostile input under test stays visible. */
const RTL_OVERRIDE = "\u202E";
const ZERO_WIDTH_ISOLATE = "\u2066";

function itemWith(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: "download-1",
    fileName: "report.pdf",
    host: "example.com",
    state: "completed",
    receivedBytes: 1024,
    totalBytes: 1024,
    canResume: false,
    directoryLabel: "Downloads",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides
  };
}

describe("safeFileName", () => {
  it("keeps an ordinary name unchanged", () => {
    expect(safeFileName("quarterly-report.pdf")).toBe("quarterly-report.pdf");
    expect(safeFileName("Photo 2026 (final).jpeg")).toBe("Photo 2026 (final).jpeg");
  });

  it("cannot produce a path, whichever separator was used", () => {
    // The guarantee is structural: no separator survives, so the result cannot
    // address a directory at all.
    for (const hostile of [
      "../../../etc/passwd",
      "..\\..\\Windows\\System32\\evil.exe",
      "/etc/shadow",
      "C:\\Windows\\system.ini",
      "nested/dir/file.txt"
    ]) {
      const safe = safeFileName(hostile);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
    }
  });

  it("strips the bidirectional overrides that disguise an extension", () => {
    // The trojan-source trick: the override reverses display order so the
    // extension the user reads is not the extension the file has.
    const disguised = `invoice${RTL_OVERRIDE}fdp.exe`;
    const safe = safeFileName(disguised);

    expect(safe).not.toContain(RTL_OVERRIDE);
    expect(safe).toBe("invoicefdp.exe");
    expect(safeFileName(`a${ZERO_WIDTH_ISOLATE}b.txt`)).toBe("ab.txt");
  });

  it("strips control characters", () => {
    expect(safeFileName("re\u0000port\u001F.pdf")).toBe("report.pdf");
    expect(safeFileName("name\u007F\u009F.txt")).toBe("name.txt");
  });

  it("removes characters no Windows filesystem accepts", () => {
    expect(safeFileName('a<b>c:d"e|f?g*h.txt')).toBe("abcdefgh.txt");
  });

  it("refuses to create a hidden file", () => {
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("...hidden.txt")).toBe("hidden.txt");
  });

  it("drops a trailing dot or space, which Windows would strip anyway", () => {
    // Left in place, the file on disk and the name in the panel would disagree.
    expect(safeFileName("report.pdf.")).toBe("report.pdf");
    expect(safeFileName("report.pdf   ")).toBe("report.pdf");
  });

  it("renames a Windows device name rather than failing to write it", () => {
    expect(safeFileName("CON.txt")).toBe("download-con.txt");
    expect(safeFileName("nul")).toBe("download-nul");
    expect(safeFileName("LPT9.dat")).toBe("download-lpt9.dat");
  });

  it("leaves a name that merely contains a device name alone", () => {
    expect(safeFileName("console.log")).toBe("console.log");
    expect(safeFileName("aux-report.pdf")).toBe("aux-report.pdf");
  });

  it("falls back rather than returning nothing", () => {
    for (const empty of ["", "   ", "...", "/", "\\", "///", "<>|?*"]) {
      expect(safeFileName(empty)).toBe("download");
    }
  });

  it("truncates a long name but keeps the extension", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const safe = safeFileName(long);

    expect(safe.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("truncates a name whose extension is itself absurd", () => {
    const safe = safeFileName(`file.${"x".repeat(300)}`);
    expect(safe.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
  });

  it("is idempotent, so a stored name survives being read back", () => {
    for (const value of ["../a/b.txt", "CON.txt", ".hidden", `x${RTL_OVERRIDE}y.exe`, ""]) {
      const once = safeFileName(value);
      expect(safeFileName(once)).toBe(once);
    }
  });
});

describe("isTerminalDownloadState", () => {
  it("treats only finished states as terminal", () => {
    const terminal: DownloadState[] = ["completed", "cancelled", "interrupted"];
    for (const state of terminal) expect(isTerminalDownloadState(state)).toBe(true);
    for (const state of ["progressing", "paused"] as DownloadState[]) {
      expect(isTerminalDownloadState(state)).toBe(false);
    }
  });
});

describe("boundDownloads", () => {
  it("keeps the most recent entries at the cap", () => {
    const items = Array.from({ length: MAX_DOWNLOADS_RETAINED + 25 }, (_unused, index) =>
      itemWith({ id: `download-${index}` })
    );

    const bounded = boundDownloads(items);

    expect(bounded).toHaveLength(MAX_DOWNLOADS_RETAINED);
    expect(bounded.at(-1)?.id).toBe(`download-${MAX_DOWNLOADS_RETAINED + 24}`);
  });

  it("leaves a short list alone", () => {
    const items = [itemWith()];
    expect(boundDownloads(items)).toBe(items);
  });
});

describe("parseDownloadIdPayload", () => {
  it("accepts an app-minted id", () => {
    expect(parseDownloadIdPayload({ downloadId: "download-3" })).toEqual({
      downloadId: "download-3"
    });
  });

  it("refuses anything that is not one", () => {
    for (const hostile of [
      null,
      [],
      "download-3",
      { downloadId: "" },
      { downloadId: 3 },
      { downloadId: "../etc/passwd" },
      { downloadId: "a b" },
      { __proto__: { polluted: true }, downloadId: "download-3" }
    ]) {
      expect(() => parseDownloadIdPayload(hostile)).toThrow();
    }
  });
});

describe("persistence", () => {
  it("round-trips finished downloads", () => {
    const snapshot = { items: [itemWith()], hasActive: false };
    const restored = parsePersistedDownloads(toPersistedDownloads(snapshot));

    expect(restored.items).toHaveLength(1);
    expect(restored.items[0]?.fileName).toBe("report.pdf");
  });

  it("never persists an in-flight download", () => {
    // Nothing is transferring after the process exits, so a restored
    // "progressing" item would render a bar that never moves.
    const snapshot = {
      items: [itemWith({ id: "download-1", state: "progressing" }), itemWith({ id: "download-2" })],
      hasActive: true
    };

    const persisted = toPersistedDownloads(snapshot);

    expect(persisted.items.map((item) => item.id)).toEqual(["download-2"]);
  });

  it("downgrades a stored live state and refuses to claim it can resume", () => {
    const restored = parsePersistedDownloads({
      version: DOWNLOAD_STATE_VERSION,
      items: [{ ...itemWith(), state: "progressing", canResume: true }]
    });

    expect(restored.items[0]?.state).toBe("interrupted");
    expect(restored.items[0]?.canResume).toBe(false);
  });

  it("re-sanitises a name that was edited on disk", () => {
    const restored = parsePersistedDownloads({
      version: DOWNLOAD_STATE_VERSION,
      items: [{ ...itemWith(), fileName: "../../../etc/passwd" }]
    });

    expect(restored.items[0]?.fileName).not.toContain("/");
  });

  it("drops one damaged entry rather than the whole history", () => {
    const restored = parsePersistedDownloads({
      version: DOWNLOAD_STATE_VERSION,
      items: [
        itemWith({ id: "download-1" }),
        { id: "not a valid id", fileName: "x.txt" },
        null,
        "nonsense",
        itemWith({ id: "download-2" })
      ]
    });

    expect(restored.items.map((item) => item.id)).toEqual(["download-1", "download-2"]);
  });

  it("drops duplicate ids", () => {
    const restored = parsePersistedDownloads({
      version: DOWNLOAD_STATE_VERSION,
      items: [itemWith({ id: "download-1" }), itemWith({ id: "download-1" })]
    });

    expect(restored.items).toHaveLength(1);
  });

  it("returns empty for anything unreadable or of the wrong version", () => {
    for (const hostile of [null, undefined, 42, "text", [], {}, { version: 99, items: [] }]) {
      expect(parsePersistedDownloads(hostile).items).toEqual([]);
    }
  });

  it("bounds a file claiming more downloads than the cap", () => {
    const restored = parsePersistedDownloads({
      version: DOWNLOAD_STATE_VERSION,
      items: Array.from({ length: MAX_DOWNLOADS_RETAINED + 500 }, (_unused, index) =>
        itemWith({ id: `download-${index}` })
      )
    });

    expect(restored.items.length).toBeLessThanOrEqual(MAX_DOWNLOADS_RETAINED);
  });
});

describe("emptyDownloadSnapshot", () => {
  it("starts with nothing active", () => {
    expect(emptyDownloadSnapshot()).toEqual({ items: [], hasActive: false });
  });
});
