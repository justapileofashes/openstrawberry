import { describe, expect, it } from "vitest";
import {
  clampSelection,
  COMMAND_GROUPS,
  COMMANDS,
  commandForChord,
  filterCommands,
  isPaletteChord,
  matchesShortcut,
  MAX_RESULTS,
  moveSelection,
  scoreCommand,
  shortcutLabel,
  type Command,
  type KeyChord
} from "./command-palette.js";

function chord(overrides: Partial<KeyChord> & { key: string }): KeyChord {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("COMMANDS", () => {
  it("has unique ids", () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("places every command in a known group", () => {
    for (const command of COMMANDS) expect(COMMAND_GROUPS).toContain(command.group);
  });

  it("assigns no chord to two commands", () => {
    // A duplicate binding means one command is unreachable and which one is
    // decided by array order, which is not a decision anyone made.
    const seen = new Set<string>();
    for (const command of COMMANDS) {
      if (command.shortcut === undefined) continue;
      const key = shortcutLabel(command.shortcut, "win32");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("does not bind the palette's own chord to a command", () => {
    for (const command of COMMANDS) {
      if (command.shortcut === undefined) continue;
      expect(shortcutLabel(command.shortcut, "win32")).not.toBe("Ctrl+K");
    }
  });
});

describe("shortcutLabel", () => {
  it("names the primary modifier for the platform", () => {
    expect(shortcutLabel({ key: "t", mod: true }, "darwin")).toBe("Cmd+T");
    expect(shortcutLabel({ key: "t", mod: true }, "win32")).toBe("Ctrl+T");
    expect(shortcutLabel({ key: "t", mod: true }, "linux")).toBe("Ctrl+T");
  });

  it("names the alt key as the platform does", () => {
    expect(shortcutLabel({ key: "ArrowLeft", alt: true }, "darwin")).toBe("Option+Left");
    expect(shortcutLabel({ key: "ArrowLeft", alt: true }, "win32")).toBe("Alt+Left");
  });

  it("orders modifiers consistently", () => {
    expect(shortcutLabel({ key: "p", mod: true, shift: true, alt: true }, "win32")).toBe(
      "Ctrl+Alt+Shift+P"
    );
  });
});

describe("matchesShortcut", () => {
  it("matches the platform's primary modifier", () => {
    expect(matchesShortcut(chord({ key: "t", ctrlKey: true }), { key: "t", mod: true }, "win32")).toBe(true);
    expect(matchesShortcut(chord({ key: "t", metaKey: true }), { key: "t", mod: true }, "darwin")).toBe(true);
  });

  it("does not accept the other platform's modifier", () => {
    // Cmd+T on Windows and Ctrl+T on macOS are both wrong, and accepting them
    // would make one binding fire for two different chords.
    expect(matchesShortcut(chord({ key: "t", metaKey: true }), { key: "t", mod: true }, "win32")).toBe(false);
    expect(matchesShortcut(chord({ key: "t", ctrlKey: true }), { key: "t", mod: true }, "darwin")).toBe(false);
  });

  it("requires modifiers to match exactly in both directions", () => {
    const shortcut = { key: "t", mod: true };
    // Ctrl+Shift+T is conventionally a different action entirely.
    expect(matchesShortcut(chord({ key: "t", ctrlKey: true, shiftKey: true }), shortcut, "win32")).toBe(false);
    expect(matchesShortcut(chord({ key: "t", ctrlKey: true, altKey: true }), shortcut, "win32")).toBe(false);
    // And a bare T must not fire a modified binding.
    expect(matchesShortcut(chord({ key: "t" }), shortcut, "win32")).toBe(false);
  });

  it("is case-insensitive about the key", () => {
    expect(matchesShortcut(chord({ key: "T", ctrlKey: true }), { key: "t", mod: true }, "win32")).toBe(true);
  });
});

describe("commandForChord", () => {
  it("resolves a bound chord", () => {
    expect(commandForChord(chord({ key: "t", ctrlKey: true }), "win32")?.id).toBe("tab.new");
    expect(commandForChord(chord({ key: "j", ctrlKey: true }), "win32")?.id).toBe("tools.downloads");
    expect(commandForChord(chord({ key: "ArrowLeft", altKey: true }), "win32")?.id).toBe("nav.back");
  });

  it("is null for an unbound chord", () => {
    expect(commandForChord(chord({ key: "q", ctrlKey: true }), "win32")).toBeNull();
    // Ordinary typing must never invoke a command.
    expect(commandForChord(chord({ key: "a" }), "win32")).toBeNull();
  });
});

describe("isPaletteChord", () => {
  it("recognises the palette binding on each platform", () => {
    expect(isPaletteChord(chord({ key: "k", ctrlKey: true }), "win32")).toBe(true);
    expect(isPaletteChord(chord({ key: "k", metaKey: true }), "darwin")).toBe(true);
  });

  it("ignores anything else", () => {
    expect(isPaletteChord(chord({ key: "k" }), "win32")).toBe(false);
    expect(isPaletteChord(chord({ key: "k", ctrlKey: true, shiftKey: true }), "win32")).toBe(false);
  });
});

describe("scoreCommand", () => {
  const newTab = COMMANDS.find((command) => command.id === "tab.new") as Command;

  it("scores an exact prefix highly", () => {
    expect(scoreCommand(newTab, "new")).not.toBeNull();
  });

  it("matches initials, which is what people type", () => {
    expect(scoreCommand(newTab, "nt")).not.toBeNull();
  });

  it("is null when a letter is absent", () => {
    expect(scoreCommand(newTab, "xyz")).toBeNull();
  });

  it("returns zero for an empty query rather than excluding the command", () => {
    expect(scoreCommand(newTab, "  ")).toBe(0);
  });

  it("ranks a visible title above a hidden keyword", () => {
    // A result whose reason you cannot see looks like a bug.
    const reader = COMMANDS.find((command) => command.id === "tools.reader") as Command;
    const address = COMMANDS.find((command) => command.id === "nav.address") as Command;

    // "read" is in reader's title and in its keywords; it is only a keyword
    // match for nothing else, so the title match must win.
    const titleScore = scoreCommand(reader, "read") ?? 0;
    const keywordOnly = scoreCommand(address, "url") ?? 0;
    expect(titleScore).toBeGreaterThan(keywordOnly);
  });
});

describe("filterCommands", () => {
  it("lists a browsable set for an empty query", () => {
    const results = filterCommands("");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
    // Catalogue order, so related commands stay together.
    expect(results[0]?.id).toBe(COMMANDS[0]?.id);
  });

  it("finds a command by its title", () => {
    expect(filterCommands("downloads")[0]?.id).toBe("tools.downloads");
  });

  it("finds a command by a keyword it does not display", () => {
    expect(filterCommands("preferences").map((c) => c.id)).toContain("tools.settings");
    expect(filterCommands("privacy").map((c) => c.id)).toContain("tools.tracking");
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands("zzzznotacommand")).toEqual([]);
  });

  it("bounds the result count", () => {
    expect(filterCommands("a").length).toBeLessThanOrEqual(MAX_RESULTS);
  });

  it("is stable for equally scored results", () => {
    // Re-running must not reshuffle rows under a user about to press Enter.
    const first = filterCommands("tab").map((command) => command.id);
    const second = filterCommands("tab").map((command) => command.id);
    expect(first).toEqual(second);
  });

  it("ignores an absurdly long query rather than choking on it", () => {
    expect(() => filterCommands("a".repeat(10_000))).not.toThrow();
  });
});

describe("moveSelection", () => {
  it("moves within the list", () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, -1, 3)).toBe(1);
  });

  it("wraps at both ends", () => {
    // Up from the top means the last one, not nothing.
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
  });

  it("is safe with no results", () => {
    expect(moveSelection(0, 1, 0)).toBe(0);
    expect(moveSelection(5, -1, 0)).toBe(0);
  });
});

describe("clampSelection", () => {
  it("keeps a selection valid as results shrink", () => {
    expect(clampSelection(9, 3)).toBe(2);
    expect(clampSelection(-4, 3)).toBe(0);
    expect(clampSelection(1, 0)).toBe(0);
  });
});
