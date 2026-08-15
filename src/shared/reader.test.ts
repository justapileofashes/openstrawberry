import { describe, expect, it } from "vitest";
import { buildReaderModeScript } from "./reader.js";

describe("reader mode script", () => {
  it("constructs a local text-only overlay rather than serializing page HTML", () => {
    const script = buildReaderModeScript();
    expect(script).toContain("textContent");
    expect(script).toContain("__openstrawberry_reader_overlay");
    expect(script).not.toContain("innerHTML");
  });
});
