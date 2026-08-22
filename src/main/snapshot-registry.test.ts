/**
 * When an element reference stops meaning anything.
 *
 * The failure this prevents is not a miss. A stale reference resolves cleanly to
 * whatever now sits in that position, so an agent acting on one is confident and
 * wrong - which is worse than being told it cannot act at all.
 */
import { describe, expect, it } from "vitest";
import { buildPageSnapshot, type PageSnapshot } from "../shared/page-snapshot.js";
import { refFailureText, SnapshotRegistry, SNAPSHOT_TTL_MS } from "./snapshot-registry.js";

function snapshotAt(generation: number, capturedAt: number): PageSnapshot {
  return buildPageSnapshot(
    [
      { role: "button", name: "Save", inViewport: true, x: 0, y: 0, width: 10, height: 10 },
      { role: "link", name: "Home", inViewport: true, x: 0, y: 20, width: 10, height: 10 }
    ],
    { generation, url: "https://example.com/", title: "Example", capturedAt }
  );
}

describe("resolving a reference", () => {
  it("finds one taken from the page that is still open", () => {
    const registry = new SnapshotRegistry({ now: () => 1_000 });
    registry.remember("tab-1", snapshotAt(4, 1_000));

    const resolved = registry.resolve("tab-1", 4, "e2");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") expect(resolved.node.name).toBe("Home");
  });

  it("tells apart never looking, a bad reference, and a page that moved on", () => {
    /*
     * Three different failures with three different next moves: snapshot first,
     * fix the reference, or snapshot again. Collapsing them would leave a model
     * guessing which of the three it had hit.
     */
    const registry = new SnapshotRegistry({ now: () => 1_000 });

    expect(registry.resolve("tab-1", 0, "e1").status).toBe("no-snapshot");

    registry.remember("tab-1", snapshotAt(4, 1_000));
    expect(registry.resolve("tab-1", 4, "e9").status).toBe("unknown-ref");
    expect(registry.resolve("tab-1", 5, "e1").status).toBe("stale");
  });

  it("expires a capture the page has had time to rearrange under", () => {
    let clock = 1_000;
    const registry = new SnapshotRegistry({ now: () => clock });
    registry.remember("tab-1", snapshotAt(4, 1_000));

    clock = 1_000 + SNAPSHOT_TTL_MS + 1;
    expect(registry.resolve("tab-1", 4, "e1").status).toBe("stale");
  });

  it("drops a stale capture rather than keeping it around", () => {
    // It holds a signed-in page's field values, nothing will ask for it again,
    // and the run it belonged to may keep going for some time.
    const registry = new SnapshotRegistry({ now: () => 1_000 });
    registry.remember("tab-1", snapshotAt(4, 1_000));

    registry.resolve("tab-1", 5, "e1");
    expect(registry.current("tab-1", 4)).toBeNull();
    expect(registry.resolve("tab-1", 4, "e1").status).toBe("no-snapshot");
  });
});

describe("current", () => {
  it("answers only for the generation the capture was taken in", () => {
    const registry = new SnapshotRegistry({ now: () => 1_000 });
    registry.remember("tab-1", snapshotAt(4, 1_000));

    expect(registry.current("tab-1", 4)?.nodes).toHaveLength(2);
    expect(registry.current("tab-1", 5)).toBeNull();
    expect(registry.current("tab-2", 4)).toBeNull();
  });
});

describe("forgetting", () => {
  it("drops a tab's capture when the tab goes", () => {
    const registry = new SnapshotRegistry({ now: () => 1_000 });
    registry.remember("tab-1", snapshotAt(0, 1_000));
    registry.forget("tab-1");

    expect(registry.current("tab-1", 0)).toBeNull();
  });

  it("clears everything at once, for a run that has ended", () => {
    const registry = new SnapshotRegistry({ now: () => 1_000 });
    registry.remember("tab-1", snapshotAt(0, 1_000));
    registry.remember("tab-2", snapshotAt(0, 1_000));
    registry.clear();

    expect(registry.current("tab-1", 0)).toBeNull();
    expect(registry.current("tab-2", 0)).toBeNull();
  });
});

describe("what the agent is told", () => {
  it("gives each failure a next move rather than only a name", () => {
    expect(refFailureText({ status: "stale" }, "e1")).toContain("snapshot again");
    expect(refFailureText({ status: "no-snapshot" }, "e1")).toContain("Call snapshot first");
    expect(
      refFailureText({ status: "unknown-ref", snapshot: snapshotAt(0, 0) }, "e9")
    ).toContain("no e9");
  });
});
