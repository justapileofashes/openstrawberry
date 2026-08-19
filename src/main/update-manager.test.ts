import { beforeEach, describe, expect, it } from "vitest";
import { UpdateManager } from "./update-manager.js";
import type { UpdateEnvironment, UpdateState } from "../shared/updates.js";
import type { UpdateTransport, UpdateTransportEvents } from "./update-transport.js";

const OPEN: UpdateEnvironment = { packaged: true, releaseReady: true, channelEnabled: true };

/** A build that is packaged but which the product refuses to update. */
const SHIPPED: UpdateEnvironment = {
  packaged: true,
  releaseReady: false,
  channelEnabled: false
};

let published: UpdateState[] = [];

/**
 * A transport that records what it was asked to do and can be made to report
 * anything back, including sequences a well-behaved server would not produce.
 * The point of the seam is that those are reachable in a test at all.
 */
class FakeTransport implements UpdateTransport {
  public readonly calls: string[] = [];
  public events: UpdateTransportEvents | null = null;

  public listen(events: UpdateTransportEvents): void {
    this.events = events;
  }

  public check(): void {
    this.calls.push("check");
  }

  public download(): void {
    this.calls.push("download");
  }

  public install(): void {
    this.calls.push("install");
  }
}

function managerWith(environment: UpdateEnvironment, transport?: UpdateTransport): UpdateManager {
  return new UpdateManager({
    environment,
    currentVersion: "0.1.0",
    publish: (state) => published.push(state),
    transport
  });
}

/** An open gate with a working transport, and the transport to drive it. */
function wired(): { manager: UpdateManager; transport: FakeTransport } {
  const transport = new FakeTransport();
  return { manager: managerWith(OPEN, transport), transport };
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

describe("an open gate with no transport", () => {
  it("does not claim an update is available", () => {
    // A build that never wired a transport must not report a state the user
    // could act on. It says the metadata is unusable, which is the truth.
    const manager = managerWith(OPEN);
    const state = manager.check();

    expect(state.status).toBe("error");
    if (state.status !== "error") return;
    expect(state.code).toBe("metadata-invalid");
  });

  it("refuses to download or install as well", () => {
    const manager = managerWith(OPEN);
    expect(manager.download().status).toBe("error");
    expect(manager.install().status).toBe("error");
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

describe("a wired channel", () => {
  it("does not touch the transport until it is asked", () => {
    const { transport } = wired();
    expect(transport.calls).toEqual([]);
    expect(published).toEqual([]);
  });

  it("reports checking while the server is being asked", () => {
    const { manager, transport } = wired();

    expect(manager.check().status).toBe("checking");
    expect(transport.calls).toEqual(["check"]);
  });

  it("surfaces an available version without fetching it", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onAvailable("0.2.0");

    const state = manager.snapshot();
    expect(state.status).toBe("available");
    if (state.status !== "available") return;
    expect(state.version).toBe("0.2.0");
    // Availability is not a download. The user has not asked yet.
    expect(transport.calls).toEqual(["check"]);
  });

  it("returns to idle when the build is current", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onNotAvailable();

    expect(manager.snapshot().status).toBe("idle");
  });

  it("walks download to downloaded and installs only then", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onAvailable("0.2.0");

    expect(manager.download().status).toBe("downloading");
    transport.events?.onProgress(41.6);

    const progress = manager.snapshot();
    expect(progress.status).toBe("downloading");
    if (progress.status !== "downloading") return;
    expect(progress.percent).toBe(42);

    transport.events?.onDownloaded("0.2.0");
    expect(manager.snapshot().status).toBe("downloaded");

    manager.install();
    expect(transport.calls).toEqual(["check", "download", "install"]);
  });

  it("refuses to download when nothing is on offer", () => {
    // The button and the handler read the same state, so a download cannot be
    // started for an update that was never found.
    const { manager, transport } = wired();
    manager.download();

    expect(transport.calls).toEqual([]);
  });

  it("refuses to install what was never downloaded", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onAvailable("0.2.0");
    manager.install();

    expect(transport.calls).toEqual(["check"]);
  });
});

describe("what a server says is not trusted", () => {
  it("treats an unparseable version as bad metadata, not as a version", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onAvailable("<script>alert(1)</script>");

    const state = manager.snapshot();
    expect(state.status).toBe("error");
    if (state.status !== "error") return;
    expect(state.code).toBe("metadata-invalid");
  });

  it("rejects a version longer than a version can be", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onAvailable("1.".repeat(200));

    expect(manager.snapshot().status).toBe("error");
  });

  it("clamps a progress report from outside the possible range", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onAvailable("0.2.0");
    manager.download();
    transport.events?.onProgress(4000);

    const state = manager.snapshot();
    if (state.status !== "downloading") throw new Error("expected downloading");
    expect(state.percent).toBe(100);
  });

  it("ignores progress for a download it never started", () => {
    const { manager, transport } = wired();
    manager.check();
    transport.events?.onProgress(50);

    expect(manager.snapshot().status).toBe("checking");
  });

  it("maps each failure to the code for that act", () => {
    for (const [cause, code] of [
      ["check", "network"],
      ["download", "download-failed"],
      ["install", "install-failed"]
    ] as const) {
      const { manager, transport } = wired();
      transport.events?.onError(cause);

      const state = manager.snapshot();
      if (state.status !== "error") throw new Error("expected error");
      expect(state.code).toBe(code);
    }
  });
});

describe("a gate that closes while the transport is still talking", () => {
  it("does not let a late event move a build that must not update", () => {
    // The transport outlives the command that started it, so "the gate was open
    // when this began" is not a licence to act on what arrives afterwards.
    const transport = new FakeTransport();
    const manager = managerWith(SHIPPED, transport);

    transport.events?.onAvailable("9.9.9");
    transport.events?.onDownloaded("9.9.9");

    expect(manager.snapshot().status).toBe("disabled");
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
