/**
 * What survives the crossing from a page into a snapshot.
 *
 * Every test here treats the input as what it is: JSON produced inside a
 * document that can redefine anything the walk touches. The question is never
 * "does this parse the happy case" but "what is the worst a page can put in the
 * agent's context, and does it get there".
 */
import { describe, expect, it } from "vitest";
import {
  buildPageSnapshot,
  describeNode,
  diffPageSnapshots,
  formatNode,
  formatPageSnapshot,
  MAX_COORDINATE,
  MAX_DIFF_LINES,
  MAX_NODE_NAME_LENGTH,
  MAX_SNAPSHOT_NODES,
  nodeByRef,
  type PageSnapshot,
  type SnapshotNode
} from "./page-snapshot.js";

const CONTEXT = {
  generation: 3,
  url: "https://example.com/",
  title: "Example",
  capturedAt: 1_000
};

function build(raw: unknown, overrides: Partial<typeof CONTEXT> = {}): PageSnapshot {
  return buildPageSnapshot(raw, { ...CONTEXT, ...overrides });
}

/** The nth node, or a failure that names the problem rather than a type error. */
function at(snapshot: PageSnapshot, index: number): SnapshotNode {
  const found = snapshot.nodes[index];
  if (found === undefined) throw new Error(`No node at ${String(index)}.`);
  return found;
}

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "button",
    name: "Submit",
    value: null,
    kind: "ordinary",
    checked: null,
    disabled: false,
    inForm: false,
    inViewport: true,
    optionIndex: null,
    x: 10,
    y: 20,
    width: 100,
    height: 40,
    ...overrides
  };
}

describe("what the page cannot decide", () => {
  it("mints references by position, ignoring any the page supplied", () => {
    // A page that could choose references could make e5 mean one thing in the
    // snapshot and another by the time it is acted on.
    const snapshot = build([node({ ref: "e99" }), node({ ref: "e99", name: "Cancel" })]);

    expect(snapshot.nodes.map((entry) => entry.ref)).toEqual(["e1", "e2"]);
  });

  it("drops an entry whose role is not one this app knows", () => {
    const snapshot = build([node({ role: "iframe" }), node({ role: "link" })]);

    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]?.role).toBe("link");
  });

  it("falls back to ordinary for a kind it does not recognise", () => {
    // Not dropped: an unknown kind must never read as a *weaker* one, and
    // ordinary is the kind with the most consent attached to it, not the least.
    expect(build([node({ kind: "trusted" })]).nodes[0]?.kind).toBe("ordinary");
  });

  it("never carries the contents of a password field", () => {
    const snapshot = build([node({ role: "textbox", kind: "password", value: "hunter2" })]);

    expect(snapshot.nodes[0]?.value).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("hunter2");
  });

  it("takes the address and title from the browser, not from the page", () => {
    const snapshot = build([node({ url: "https://evil.test/", title: "Your Bank" })]);

    expect(snapshot.url).toBe("https://example.com/");
    expect(snapshot.title).toBe("Example");
  });
});

describe("bounds", () => {
  it("caps how many nodes one capture reports, and says how many it dropped", () => {
    const snapshot = build(Array.from({ length: MAX_SNAPSHOT_NODES + 7 }, () => node()));

    expect(snapshot.nodes).toHaveLength(MAX_SNAPSHOT_NODES);
    expect(snapshot.dropped).toBe(7);
    expect(formatPageSnapshot(snapshot)).toContain("7 further elements not shown");
  });

  it("cuts a name long enough to bury a paragraph of instructions in", () => {
    const snapshot = build([node({ name: "x".repeat(5_000) })]);

    expect(snapshot.nodes[0]?.name).toHaveLength(MAX_NODE_NAME_LENGTH);
  });

  it("collapses whitespace so a name cannot span lines", () => {
    // A multi-line name would let a page draw its own block boundaries inside
    // what is meant to be one line of a list.
    expect(build([node({ name: "Log\n\n  in   now" })]).nodes[0]?.name).toBe("Log in now");
  });

  it("clamps a rect to something an input event could actually aim at", () => {
    const snapshot = build([
      node({ x: -40, y: Number.POSITIVE_INFINITY, width: 1e12, height: "40" })
    ]);

    expect(snapshot.nodes[0]?.rect).toEqual({
      x: 0,
      y: 0,
      width: MAX_COORDINATE,
      height: 0
    });
  });

  it("rounds a fractional coordinate, because an event takes integers", () => {
    expect(build([node({ x: 10.6, y: 20.2 })]).nodes[0]?.rect.x).toBe(11);
  });

  it("ignores entries that are not objects at all", () => {
    expect(build([null, "e1", 42, [], node()]).nodes).toHaveLength(1);
  });

  it("treats a non-array answer as an empty page", () => {
    expect(build({ nodes: [node()] }).nodes).toHaveLength(0);
    expect(build(null).nodes).toHaveLength(0);
  });
});

describe("options and their controls", () => {
  it("pairs each option with the control above it", () => {
    const snapshot = build([
      node({ role: "combobox", name: "Country", optionIndex: 0 }),
      node({ role: "option", name: "Chile", optionIndex: 0 }),
      node({ role: "option", name: "Peru", optionIndex: 1 })
    ]);

    expect(snapshot.nodes[1]?.ownerRef).toBe("e1");
    expect(snapshot.nodes[2]?.ownerRef).toBe("e1");
    // Only an option belongs to something; the control itself does not.
    expect(snapshot.nodes[0]?.ownerRef).toBeNull();
  });

  it("keeps -1, which is what a control with nothing selected reports", () => {
    expect(build([node({ role: "combobox", optionIndex: -1 })]).nodes[0]?.optionIndex).toBe(-1);
  });

  it("refuses an index outside the range a selection could walk", () => {
    expect(build([node({ role: "option", optionIndex: 5_000 })]).nodes[0]?.optionIndex).toBeNull();
  });
});

describe("wording", () => {
  it("puts the reference first, because it is what act takes", () => {
    expect(formatNode(at(build([node()]), 0))).toBe('[e1] button "Submit"');
  });

  it("marks the things that change what an agent may do with it", () => {
    const snapshot = build([
      node({ kind: "submit", disabled: true, inViewport: false, name: "Pay" })
    ]);

    expect(formatNode(at(snapshot, 0))).toBe(
      '[e1] button "Pay" (submit, disabled, off-screen)'
    );
  });

  it("shows a checkbox as a state rather than as a value", () => {
    const snapshot = build([node({ role: "checkbox", name: "Remember me", checked: false })]);
    expect(formatNode(at(snapshot, 0))).toBe('[e1] checkbox "Remember me" unchecked');
  });

  it("names the control an option belongs to", () => {
    const snapshot = build([
      node({ role: "combobox", name: "Country" }),
      node({ role: "option", name: "Peru", optionIndex: 1 })
    ]);

    expect(formatNode(at(snapshot, 1))).toBe('[e2] option "Peru" of e1');
  });

  it("describes a node for a person, who has never seen a reference", () => {
    expect(describeNode(at(build([node({ name: "Pay now" })]), 0))).toBe(
      'the button "Pay now"'
    );
    expect(describeNode(at(build([node({ name: "" })]), 0))).toBe("a button");
  });

  it("says what to do when a page reports nothing", () => {
    expect(formatPageSnapshot(build([]))).toContain("read_page may still work");
  });
});

describe("nodeByRef", () => {
  it("finds a node, and answers null rather than guessing", () => {
    const snapshot = build([node(), node({ name: "Cancel" })]);

    expect(nodeByRef(snapshot, "e2")?.name).toBe("Cancel");
    expect(nodeByRef(snapshot, "e9")).toBeNull();
  });
});

describe("the diff, which is how an action is verified", () => {
  it("reports an element that appeared", () => {
    const before = build([node({ name: "Save" })]);
    const after = build([node({ name: "Save" }), node({ role: "alert", name: "Saved" })]);

    expect(diffPageSnapshots(before, after)).toContain('+ [e2] alert "Saved"');
  });

  it("reports an element that went", () => {
    const before = build([node({ name: "Save" }), node({ name: "Cancel" })]);
    const after = build([node({ name: "Save" })]);

    expect(diffPageSnapshots(before, after)).toContain('- button "Cancel"');
  });

  it("reports a state change, with both sides of it", () => {
    const before = build([node({ role: "checkbox", name: "Email me", checked: false })]);
    const after = build([node({ role: "checkbox", name: "Email me", checked: true })]);

    expect(diffPageSnapshots(before, after)).toContain(
      '~ [e1] checkbox "Email me": unchecked -> checked'
    );
  });

  it("survives renumbering, which is the whole reason it matches on name", () => {
    /*
     * Something appearing at the top shifts every reference below it. Matching
     * on the reference would report the entire page as changed; matching on what
     * the element is reports the one thing that did.
     */
    const before = build([node({ name: "Save" }), node({ name: "Cancel" })]);
    const after = build([
      node({ role: "alert", name: "Heads up" }),
      node({ name: "Save" }),
      node({ name: "Cancel" })
    ]);

    const diff = diffPageSnapshots(before, after);
    expect(diff).toContain('+ [e1] alert "Heads up"');
    expect(diff).not.toContain('button "Save"');
    expect(diff).not.toContain('button "Cancel"');
  });

  it("names a navigation first, because it explains everything under it", () => {
    const before = build([node()]);
    const after = build([node()], { url: "https://example.com/done" });

    expect(diffPageSnapshots(before, after).split("\n")[0]).toBe(
      "> now at https://example.com/done"
    );
  });

  it("says plainly when nothing changed, which is a real answer", () => {
    const snapshot = build([node()]);
    expect(diffPageSnapshots(snapshot, snapshot)).toContain("Nothing on the page changed");
  });

  it("bounds a page that re-rendered wholesale", () => {
    // Otherwise a single click on a page that redraws itself returns a diff
    // longer than the snapshot it was derived from.
    const before = build([]);
    const after = build(Array.from({ length: 200 }, (_, index) => node({ name: `Row ${index}` })));

    const diff = diffPageSnapshots(before, after);
    expect(diff).toContain("further changes not shown");
    expect(diff.split("\n").length).toBeLessThanOrEqual(MAX_DIFF_LINES + 1);
  });
});

