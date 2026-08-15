import { describe, expect, it } from "vitest";
import { resolveBrowserShortcut } from "./keyboard.js";

describe("browser keyboard shortcuts", () => {
  it("supports Ctrl or Command as the primary modifier", () => {
    expect(resolveBrowserShortcut({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("command-palette");
    expect(resolveBrowserShortcut({ key: "l", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe("address-bar");
  });

  it("preserves modifier intent for new tabs and split toggles", () => {
    expect(resolveBrowserShortcut({ key: "t", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("new-tab");
    expect(resolveBrowserShortcut({ key: "s", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe("toggle-split");
    expect(resolveBrowserShortcut({ key: "s", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })).toBe("none");
  });
});
