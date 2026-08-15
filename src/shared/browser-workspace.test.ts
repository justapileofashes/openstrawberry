import { describe, expect, it } from "vitest";
import { validateTabGroupName, validateWorkspaceName } from "./browser.js";

describe("workspace names", () => {
  it("normalizes visible whitespace without creating unsafe implicit names", () => {
    expect(validateWorkspaceName("  Research   session  ")).toBe("Research session");
    expect(() => validateWorkspaceName("   ")).toThrow("required");
  });

  it("uses a short, normalized name for durable local tab groups", () => {
    expect(validateTabGroupName("  Design   review ")).toBe("Design review");
    expect(() => validateTabGroupName(" ")).toThrow("required");
    expect(() => validateTabGroupName("x".repeat(41))).toThrow("40");
  });
});
