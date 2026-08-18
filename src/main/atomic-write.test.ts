import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PRIVATE_FILE_MODE, writeFileAtomically } from "./atomic-write.js";

let directory = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-atomic-"));
});

describe("writeFileAtomically", () => {
  it("writes text a reader gets back unchanged", () => {
    const path = join(directory, "state.json");
    writeFileAtomically(path, '{"version":1}');
    expect(readFileSync(path, "utf8")).toBe('{"version":1}');
  });

  it("writes bytes without reinterpreting them as text", () => {
    const path = join(directory, "credentials.enc");
    const ciphertext = Uint8Array.from([0, 255, 128, 10, 13]);

    writeFileAtomically(path, ciphertext);

    expect(Uint8Array.from(readFileSync(path))).toEqual(ciphertext);
  });

  it("replaces existing contents rather than appending to them", () => {
    const path = join(directory, "state.json");
    writeFileAtomically(path, "first, and longer than what follows");
    writeFileAtomically(path, "second");

    expect(readFileSync(path, "utf8")).toBe("second");
  });

  it("leaves no temporary file behind", () => {
    const path = join(directory, "state.json");
    writeFileAtomically(path, "contents");

    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("reports a write it could not make instead of losing it quietly", () => {
    // A caller that catches this keeps its in-memory state and can say so. A
    // silent failure would leave the store believing it had persisted.
    const path = join(directory, "missing-parent", "state.json");

    expect(() => writeFileAtomically(path, "contents")).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("leaves the destination and the directory untouched when the rename fails", () => {
    // The guarantee the rename buys: a write that cannot complete does not
    // damage what was already there, and does not strand a temporary file. A
    // directory standing at the destination is a reproducible stand-in for the
    // rename failing for any other reason.
    const path = join(directory, "occupied");
    mkdirSync(path);
    writeFileSync(join(path, "kept.txt"), "still here");

    expect(() => writeFileAtomically(path, "contents")).toThrow();

    expect(statSync(path).isDirectory()).toBe(true);
    expect(readFileSync(join(path, "kept.txt"), "utf8")).toBe("still here");
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("creates the file owner-only where the platform honours modes", () => {
    const path = join(directory, "credentials.enc");
    writeFileAtomically(path, "ciphertext");

    // Windows does not implement POSIX permission bits, so the assertion is made
    // only where the mode means something.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(PRIVATE_FILE_MODE);
    }
    expect(existsSync(path)).toBe(true);
  });
});
