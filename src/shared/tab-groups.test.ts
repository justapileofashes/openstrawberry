import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_COLOUR,
  GROUP_COLOURS,
  groupName,
  MAX_GROUP_NAME_LENGTH,
  MAX_TAB_GROUPS,
  nextColour,
  parseAssignTabPayload,
  parseColour,
  parseCreateGroupPayload,
  parseGroupIdPayload,
  parseTabGroups,
  parseUpdateGroupPayload,
  pruneEmptyGroups,
  type TabGroup
} from "./tab-groups.js";

const RTL_OVERRIDE = "\u202E";

function group(overrides: Partial<TabGroup> = {}): TabGroup {
  return { id: "group-1", name: "Research", colour: "slate", collapsed: false, ...overrides };
}

describe("GROUP_COLOURS", () => {
  it("is a closed set of tokens, never CSS values", () => {
    // The stylesheet owns what a colour looks like; stored state must never
    // carry a string that could reach a style attribute.
    for (const colour of GROUP_COLOURS) expect(colour).toMatch(/^[a-z]+$/u);
    expect(GROUP_COLOURS).toContain(DEFAULT_GROUP_COLOUR);
    expect(new Set(GROUP_COLOURS).size).toBe(GROUP_COLOURS.length);
  });
});

describe("parseColour", () => {
  it("accepts a shipped token", () => {
    expect(parseColour("amber")).toBe("amber");
  });

  it("falls back for anything else", () => {
    for (const value of ["#ff0000", "red; background: url(x)", "", null, 42, "AMBER"]) {
      expect(parseColour(value)).toBe(DEFAULT_GROUP_COLOUR);
    }
  });
});

describe("nextColour", () => {
  it("cycles the palette so consecutive groups differ", () => {
    expect(nextColour(0)).toBe(GROUP_COLOURS[0]);
    expect(nextColour(1)).toBe(GROUP_COLOURS[1]);
    expect(nextColour(GROUP_COLOURS.length)).toBe(GROUP_COLOURS[0]);
  });
});

describe("groupName", () => {
  it("collapses whitespace and bounds length", () => {
    expect(groupName("  a   b ")).toBe("a b");
    expect(groupName("n".repeat(200)).length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);
  });

  it("strips characters that render as something else", () => {
    expect(groupName(`Work${RTL_OVERRIDE}group`)).toBe("Workgroup");
    expect(groupName("a\u0000b")).toBe("ab");
  });

  it("falls back when nothing readable remains", () => {
    for (const value of ["", "   ", RTL_OVERRIDE, null, 42]) {
      expect(groupName(value)).toBe("");
    }
  });
});

describe("parseTabGroups", () => {
  it("reads well-formed groups", () => {
    expect(parseTabGroups([group(), group({ id: "group-2", name: "Docs" })])).toHaveLength(2);
  });

  it("drops a group with no readable name", () => {
    // A coloured bar nothing can identify is worse than no group.
    expect(parseTabGroups([group({ name: "   " })])).toEqual([]);
    expect(parseTabGroups([group({ name: RTL_OVERRIDE })])).toEqual([]);
  });

  it("defaults a colour outside the palette rather than storing it", () => {
    const parsed = parseTabGroups([{ ...group(), colour: "url(javascript:alert(1))" }]);
    expect(parsed[0]?.colour).toBe(DEFAULT_GROUP_COLOUR);
  });

  it("drops damaged entries and duplicates rather than the whole list", () => {
    const parsed = parseTabGroups([
      group({ id: "group-1" }),
      null,
      "nonsense",
      { id: "not a valid id", name: "X" },
      group({ id: "group-1", name: "Duplicate" }),
      group({ id: "group-2", name: "Docs" })
    ]);

    expect(parsed.map((entry) => entry.id)).toEqual(["group-1", "group-2"]);
  });

  it("returns empty for anything that is not a list", () => {
    for (const value of [null, undefined, 42, "text", {}]) {
      expect(parseTabGroups(value)).toEqual([]);
    }
  });

  it("bounds a file claiming more groups than the cap", () => {
    const many = Array.from({ length: MAX_TAB_GROUPS + 30 }, (_u, i) =>
      group({ id: `group-${i}` })
    );
    expect(parseTabGroups(many).length).toBeLessThanOrEqual(MAX_TAB_GROUPS);
  });
});

describe("pruneEmptyGroups", () => {
  it("keeps groups something belongs to", () => {
    const groups = [group({ id: "group-1" }), group({ id: "group-2", name: "Docs" })];
    expect(pruneEmptyGroups(groups, ["group-1", null]).map((g) => g.id)).toEqual(["group-1"]);
  });

  it("drops everything when nothing is grouped", () => {
    expect(pruneEmptyGroups([group()], [null, null])).toEqual([]);
  });
});

describe("payload validators", () => {
  it("accepts well-formed payloads", () => {
    expect(parseCreateGroupPayload({ tabId: "tab-1", name: " Reading " })).toEqual({
      tabId: "tab-1",
      name: "Reading"
    });
    expect(parseGroupIdPayload({ groupId: "group-1" })).toEqual({ groupId: "group-1" });
    expect(
      parseUpdateGroupPayload({
        groupId: "group-1",
        name: "Docs",
        colour: "teal",
        collapsed: true
      })
    ).toEqual({ groupId: "group-1", name: "Docs", colour: "teal", collapsed: true });
  });

  it("refuses a colour outside the palette on update", () => {
    // Defaulting would silently accept a payload that did not come from the
    // chrome; the chrome only ever offers shipped tokens.
    expect(() =>
      parseUpdateGroupPayload({
        groupId: "group-1",
        name: "Docs",
        colour: "#bada55",
        collapsed: false
      })
    ).toThrow();
  });

  it("refuses a name that reduces to nothing", () => {
    expect(() => parseCreateGroupPayload({ tabId: "tab-1", name: "   " })).toThrow();
    expect(() => parseCreateGroupPayload({ tabId: "tab-1", name: RTL_OVERRIDE })).toThrow();
  });

  it("does not coerce collapsed", () => {
    for (const collapsed of ["true", 1, null]) {
      expect(() =>
        parseUpdateGroupPayload({ groupId: "group-1", name: "D", colour: "teal", collapsed })
      ).toThrow();
    }
  });

  it("treats a null group as removal from any group", () => {
    expect(parseAssignTabPayload({ tabId: "tab-1", groupId: null })).toEqual({
      tabId: "tab-1",
      groupId: null
    });
    expect(parseAssignTabPayload({ tabId: "tab-1" })).toEqual({
      tabId: "tab-1",
      groupId: null
    });
  });

  it("refuses malformed identifiers", () => {
    for (const hostile of [null, [], "tab-1", { tabId: "" }, { tabId: "../x" }]) {
      expect(() => parseAssignTabPayload(hostile)).toThrow();
    }
    expect(() => parseAssignTabPayload({ tabId: "tab-1", groupId: "bad id" })).toThrow();
  });
});
