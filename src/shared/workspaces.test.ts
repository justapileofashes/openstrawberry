import { describe, expect, it } from "vitest";
import {
  emptyWorkspaceSnapshot,
  emptyWorkspaceState,
  isSavableUrl,
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACE_TABS,
  MAX_WORKSPACES,
  parseSaveWorkspacePayload,
  parseWorkspaceIdPayload,
  parseWorkspaces,
  toWorkspaceTabs,
  workspaceText,
  WORKSPACE_STATE_VERSION,
  type Workspace
} from "./workspaces.js";

const RTL_OVERRIDE = "\u202E";

function workspaceWith(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "workspace-1",
    name: "Research",
    tabs: [{ url: "https://example.com/a", title: "A" }],
    savedAt: 1_700_000_000_000,
    ...overrides
  };
}

describe("isSavableUrl", () => {
  it("accepts http and https", () => {
    expect(isSavableUrl("https://example.com/path")).toBe(true);
    expect(isSavableUrl("http://localhost:5173/")).toBe(true);
  });

  it("refuses every other scheme", () => {
    for (const value of [
      "about:blank",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "chrome://settings",
      "ftp://example.com"
    ]) {
      expect(isSavableUrl(value)).toBe(false);
    }
  });

  it("refuses a URL carrying credentials", () => {
    // A phishing staple, and not something to persist under a friendly name.
    expect(isSavableUrl("https://user:pass@example.com/")).toBe(false);
  });

  it("refuses anything unparseable, empty, or over-long", () => {
    for (const value of [null, 42, "", "nonsense", `https://example.com/${"a".repeat(5000)}`]) {
      expect(isSavableUrl(value)).toBe(false);
    }
  });
});

describe("workspaceText", () => {
  it("collapses whitespace and bounds length", () => {
    expect(workspaceText("  a   b  ", 50)).toBe("a b");
    expect(workspaceText("x".repeat(200), 10).length).toBeLessThanOrEqual(10);
  });

  it("strips characters that would render as something else", () => {
    expect(workspaceText(`safe${RTL_OVERRIDE}name`, 50)).toBe("safename");
    expect(workspaceText("a\u0000b", 50)).toBe("ab");
  });

  it("returns empty for a non-string", () => {
    for (const value of [null, undefined, 42, {}]) expect(workspaceText(value, 50)).toBe("");
  });
});

describe("toWorkspaceTabs", () => {
  it("keeps navigable tabs and drops the rest", () => {
    const tabs = toWorkspaceTabs([
      { url: "https://example.com/a", title: "A" },
      { url: "about:blank", title: "New tab" },
      { url: "file:///secret", title: "Local" },
      { url: "https://example.com/b", title: "B" }
    ]);

    // A blank tab among real ones must not stop the real ones being saved.
    expect(tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b"
    ]);
  });

  it("sanitises titles taken from pages", () => {
    const tabs = toWorkspaceTabs([
      { url: "https://example.com/a", title: `Title${RTL_OVERRIDE}here` }
    ]);
    expect(tabs[0]?.title).toBe("Titlehere");
  });

  it("carries no field a session or credential would fit in", () => {
    const tabs = toWorkspaceTabs([{ url: "https://example.com/a", title: "A" }]);
    expect(Object.keys(tabs[0] ?? {})).toEqual(["url", "title"]);
  });

  it("bounds how many tabs one workspace holds", () => {
    const many = Array.from({ length: MAX_WORKSPACE_TABS + 40 }, (_u, i) => ({
      url: `https://example.com/${i}`,
      title: `T${i}`
    }));
    expect(toWorkspaceTabs(many).length).toBe(MAX_WORKSPACE_TABS);
  });
});

describe("payload validators", () => {
  it("accepts a real name and an app-minted id", () => {
    expect(parseSaveWorkspacePayload({ name: "  Morning reading " })).toEqual({
      name: "Morning reading"
    });
    expect(parseWorkspaceIdPayload({ workspaceId: "workspace-2" })).toEqual({
      workspaceId: "workspace-2"
    });
  });

  it("refuses a name that is only invisible characters", () => {
    // It would render as a blank row nothing could identify.
    expect(() => parseSaveWorkspacePayload({ name: RTL_OVERRIDE })).toThrow();
    expect(() => parseSaveWorkspacePayload({ name: "   " })).toThrow();
  });

  it("refuses malformed payloads without coercing", () => {
    for (const hostile of [null, [], "name", { name: 42 }, { name: "" }]) {
      expect(() => parseSaveWorkspacePayload(hostile)).toThrow();
    }
    for (const hostile of [null, { workspaceId: "" }, { workspaceId: "../x" }]) {
      expect(() => parseWorkspaceIdPayload(hostile)).toThrow();
    }
  });

  it("bounds a very long name rather than storing it", () => {
    const parsed = parseSaveWorkspacePayload({ name: "n".repeat(MAX_WORKSPACE_NAME_LENGTH) });
    expect(parsed.name.length).toBeLessThanOrEqual(MAX_WORKSPACE_NAME_LENGTH);
  });
});

describe("persistence", () => {
  it("round-trips a workspace", () => {
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [workspaceWith()]
    });

    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.name).toBe("Research");
  });

  it("applies the scheme gate again on read", () => {
    // A hand-edited file must not be able to introduce a scheme the browser
    // would refuse anyway.
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        workspaceWith({
          tabs: [
            { url: "file:///etc/passwd", title: "Local" },
            { url: "javascript:alert(1)", title: "Script" },
            { url: "https://example.com/ok", title: "Fine" }
          ]
        })
      ]
    });

    expect(state.workspaces[0]?.tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/ok"
    ]);
  });

  it("drops a workspace left with no navigable address", () => {
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [workspaceWith({ tabs: [{ url: "file:///x", title: "L" }] })]
    });

    expect(state.workspaces).toEqual([]);
  });

  it("drops one damaged entry rather than the whole file", () => {
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        workspaceWith({ id: "workspace-1" }),
        null,
        "nonsense",
        { id: "not a valid id", name: "X", tabs: [] },
        workspaceWith({ id: "workspace-2", name: "Other" })
      ]
    });

    expect(state.workspaces.map((w) => w.id)).toEqual(["workspace-1", "workspace-2"]);
  });

  it("drops duplicate ids", () => {
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [workspaceWith(), workspaceWith({ name: "Duplicate" })]
    });
    expect(state.workspaces).toHaveLength(1);
  });

  it("bounds a file claiming more workspaces than the cap", () => {
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: Array.from({ length: MAX_WORKSPACES + 100 }, (_u, i) =>
        workspaceWith({ id: `workspace-${i}` })
      )
    });
    expect(state.workspaces.length).toBeLessThanOrEqual(MAX_WORKSPACES);
  });

  it("returns empty for anything unreadable or of the wrong version", () => {
    for (const hostile of [null, 42, "text", [], { version: 99, workspaces: [] }]) {
      expect(parseWorkspaces(hostile)).toEqual(emptyWorkspaceState());
    }
  });

  it("never restores a field that was not saved", () => {
    // Whatever a file claims, only url and title survive; there is nowhere for a
    // cookie or a token to land.
    const state = parseWorkspaces({
      version: WORKSPACE_STATE_VERSION,
      workspaces: [
        {
          ...workspaceWith(),
          cookies: "session=abc123",
          tabs: [{ url: "https://example.com/a", title: "A", cookie: "secret", token: "t" }]
        }
      ]
    });

    expect(Object.keys(state.workspaces[0]?.tabs[0] ?? {})).toEqual(["url", "title"]);
    expect(JSON.stringify(state)).not.toContain("secret");
    expect(JSON.stringify(state)).not.toContain("session=abc123");
  });
});

describe("emptyWorkspaceSnapshot", () => {
  it("starts with nothing saved", () => {
    expect(emptyWorkspaceSnapshot()).toEqual({ workspaces: [] });
  });
});
