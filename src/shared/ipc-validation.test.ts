import { describe, expect, it } from "vitest";
import { parseAgentRunRequest, parseMediaCommand, parseTabGroupAssignment, parseTabGroupCreate, parseViewport, requireBrowserId, requirePane } from "./ipc-validation.js";

describe("IPC validation", () => {
  it("accepts bounded valid browser-control payloads", () => {
    expect(requirePane("primary")).toBe("primary");
    expect(requireBrowserId("chrome")).toBe("chrome");
    expect(parseViewport({ paneId: "secondary", x: 0, y: 5, width: 720, height: 480 })).toEqual({ paneId: "secondary", x: 0, y: 5, width: 720, height: 480 });
    expect(parseMediaCommand({ action: "volume", value: 0.5 })).toEqual({ action: "volume", value: 0.5 });
    expect(parseTabGroupCreate({ name: " Focus ", color: "violet", tabIds: ["tab-1", "tab-1"] })).toEqual({ name: "Focus", color: "violet", tabIds: ["tab-1"] });
    expect(parseTabGroupAssignment({ tabId: "tab-1", groupId: null })).toEqual({ tabId: "tab-1", groupId: undefined });
  });

  it("rejects malformed objects, invalid enum values, and unsafe bounds", () => {
    expect(() => requirePane("other")).toThrow("Unsupported");
    expect(() => requireBrowserId("file")).toThrow("Unsupported");
    expect(() => parseViewport({ paneId: "primary", x: -1, y: 0, width: 1, height: 1 })).toThrow("invalid");
    expect(() => parseMediaCommand({ action: "volume", value: 2 })).toThrow("Invalid");
    expect(() => parseAgentRunRequest({ agentId: "coder", prompt: "x".repeat(24_001) })).toThrow("too long");
    expect(() => parseTabGroupCreate({ name: "Focus", color: "hot-pink", tabIds: ["tab-1"] })).toThrow("color");
    expect(() => parseTabGroupCreate({ name: "Focus", color: "blue", tabIds: [] })).toThrow("Invalid");
    expect(() => parseTabGroupAssignment({ tabId: "!!!" })).toThrow("invalid");
  });
});
