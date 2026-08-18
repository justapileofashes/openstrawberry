import { beforeEach, describe, expect, it } from "vitest";
import { UpdateManager } from "./update-manager.js";
import type { UpdateEnvironment, UpdateState } from "../shared/updates.js";

const OPEN: UpdateEnvironment = { packaged: true, releaseReady: true, channelEnabled: true };

/** What this product actually ships today. */
const SHIPPED: UpdateEnvironment = {
  packaged: true,
  releaseReady: false,
  channelEnabled: false
};

let published: UpdateState[] = [];

function managerWith(environment: UpdateEnvironment): UpdateManager {
  return new UpdateManager({
    environment,
    currentVersion: "0.1.0",
    publish: (state) => published.push(state)
  });
}

beforeEach(() => {
  published = [];
});

describe("the shipped configuration", () => {
  it("starts disabled", () => {
    expect(managerWith(SHIPPED).snapshot().status).toBe("disabled");
  });

  it("names why, so the state is actionable rather than mysterious", () => {
    const state = managerWith(SHIPPED).snapshot();
    if (state.status !== "disabled") throw new Error("expected disabled");

    expect(state.blockers).toEqual(["not-release-ready", "channel-disabled"]);
  });

  it("refuses every command", () => {
    const manager = managerWith(SHIPPED);

    for (const result of [manager.check(), manager.download(), manager.install()]) {
      expect(result.status).toBe("disabled");
    }
  });

  it("stays disabled however many times it is asked", () => {
    // The gate is re-asked per command rather than decided once, so nothing
    // accumulates toward being allowed.
    const manager = managerWith(SHIPPED);
    for (let attempt = 0; attempt < 5; attempt += 1) manager.check();

    expect(manager.snapshot().status).toBe("disabled");
  });
});

describe("a build that must not update", () => {
  it("refuses a development build even with everything else on", () => {
    const manager = managerWith({ ...OPEN, packaged: false });

    expect(manager.check().status).toBe("disabled");
    const state = manager.snapshot();
    if (state.status !== "disabled") throw new Error("expected disabled");
    expect(state.blockers).toEqual(["not-packaged"]);
  });

  it("refuses an unsigned release even with the channel on", () => {
    const manager = managerWith({ ...OPEN, releaseReady: false });
    expect(manager.download().status).toBe("disabled");
  });

  it("refuses when only the channel is off", () => {
    const manager = managerWith({ ...OPEN, channelEnabled: false });
    expect(manager.install().status).toBe("disabled");
  });

  it("restates the whole gate on refusal rather than leaving a stale state", () => {
    // A build that must never update must not be left displaying `available`.
    const manager = managerWith(SHIPPED);
    manager.check();

    expect(published.at(-1)?.status).toBe("disabled");
  });
});

describe("an open gate", () => {
  it("does not claim an update is available, because nothing is wired", () => {
    // Reporting something the user could act on would be a lie about what this
    // build can do. The transport lands after signed artifacts exist.
    const manager = managerWith(OPEN);
    expect(manager.check().status).toBe("error");
  });

  it("starts idle at the current version", () => {
    const state = managerWith(OPEN).snapshot();

    expect(state.status).toBe("idle");
    if (state.status !== "idle") return;
    expect(state.currentVersion).toBe("0.1.0");
  });

  it("never starts checking on its own", () => {
    // No check-on-launch: the channel moves only when a person presses
    // something.
    managerWith(OPEN);
    expect(published).toEqual([]);
  });
});

describe("lifecycle", () => {
  it("publishes each transition", () => {
    const manager = managerWith(SHIPPED);
    manager.check();
    expect(published.length).toBe(1);
  });

  it("publishes nothing after teardown", () => {
    const manager = managerWith(SHIPPED);
    manager.destroy();
    manager.check();

    expect(published).toEqual([]);
  });

  it("is safe to destroy twice", () => {
    const manager = managerWith(SHIPPED);
    manager.destroy();
    expect(() => manager.destroy()).not.toThrow();
  });
});
