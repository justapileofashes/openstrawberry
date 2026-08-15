import { describe, expect, it } from "vitest";
import { validateWorkspaceName } from "./browser.js";

describe("workspace names", () => {
  it("normalizes visible whitespace without creating unsafe implicit names", () => {
    expect(validateWorkspaceName("  Research   session  ")).toBe("Research session");
    expect(() => validateWorkspaceName("   ")).toThrow("required");
  });
});
