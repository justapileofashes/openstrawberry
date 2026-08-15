import { describe, expect, it } from "vitest";
import { downloadProgress } from "./download.js";

describe("download progress", () => {
  it("handles known totals and clamps completed values", () => {
    expect(downloadProgress(250, 1000)).toBe(25);
    expect(downloadProgress(1500, 1000)).toBe(100);
  });

  it("keeps unknown or invalid totals distinct from a real zero percent", () => {
    expect(downloadProgress(5, 0)).toBeNull();
  });
});
