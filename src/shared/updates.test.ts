import { describe, expect, it } from "vitest";
import {
  canCheck,
  canDownload,
  canInstall,
  initialUpdateState,
  isUpdateAllowed,
  MAX_VERSION_LENGTH,
  parsePercent,
  parseUpdateVersionPayload,
  parseVersion,
  updateBlockers,
  UPDATE_STATUSES,
  type UpdateEnvironment,
  type UpdateState
} from "./updates.js";

const READY: UpdateEnvironment = {
  packaged: true,
  releaseReady: true,
  channelEnabled: true
};

describe("the gate", () => {
  it("allows the channel only when all three facts agree", () => {
    expect(isUpdateAllowed(READY)).toBe(true);
  });

  it("refuses when any single one is false", () => {
    // The conjunction is the safety property: no single edit turns
    // downloading-and-running-code on.
    expect(isUpdateAllowed({ ...READY, packaged: false })).toBe(false);
    expect(isUpdateAllowed({ ...READY, releaseReady: false })).toBe(false);
    expect(isUpdateAllowed({ ...READY, channelEnabled: false })).toBe(false);
  });

  it("reports every reason rather than the first", () => {
    // A maintainer turning the channel on should see signing is also
    // outstanding, not discover it one refusal at a time.
    const blockers = updateBlockers({
      packaged: false,
      releaseReady: false,
      channelEnabled: false
    });

    expect(blockers).toEqual(["not-packaged", "not-release-ready", "channel-disabled"]);
  });

  it("reports nothing when the channel is allowed", () => {
    expect(updateBlockers(READY)).toEqual([]);
  });

  it("names a development build separately from an unsigned one", () => {
    // Different problems with different fixes; one message for both helps
    // neither.
    expect(updateBlockers({ ...READY, packaged: false })).toEqual(["not-packaged"]);
    expect(updateBlockers({ ...READY, releaseReady: false })).toEqual(["not-release-ready"]);
  });
});

describe("initialUpdateState", () => {
  it("starts disabled with its reasons when the gate refuses", () => {
    const state = initialUpdateState({ ...READY, releaseReady: false }, "0.1.0");

    expect(state.status).toBe("disabled");
    if (state.status !== "disabled") return;
    expect(state.blockers).toEqual(["not-release-ready"]);
  });

  it("starts idle, never checking, when the gate allows", () => {
    // There is no check-on-launch state: the channel moves only when a person
    // presses something.
    const state = initialUpdateState(READY, "0.1.0");

    expect(state.status).toBe("idle");
    if (state.status !== "idle") return;
    expect(state.currentVersion).toBe("0.1.0");
  });

  it("is disabled for this product today", () => {
    // The shipped configuration: not release ready, channel off.
    const state = initialUpdateState(
      { packaged: true, releaseReady: false, channelEnabled: false },
      "0.1.0"
    );
    expect(state.status).toBe("disabled");
  });
});

describe("parseVersion", () => {
  it("accepts what a version looks like", () => {
    for (const value of ["0.1.0", "1.2.3-beta.4", "2.0.0+build7"]) {
      expect(parseVersion(value), value).toBe(value);
    }
  });

  it("refuses anything that could carry something else", () => {
    // Remote metadata, about to be displayed.
    for (const value of [
      "<script>alert(1)</script>",
      "1.0.0 or so",
      "../../etc",
      "1.0.0\u202E",
      "",
      "   ",
      null,
      42,
      "v".repeat(MAX_VERSION_LENGTH + 1)
    ]) {
      expect(parseVersion(value)).toBeNull();
    }
  });

  it("trims surrounding space", () => {
    expect(parseVersion("  1.0.0  ")).toBe("1.0.0");
  });
});

describe("parsePercent", () => {
  it("clamps into range and rounds", () => {
    expect(parsePercent(42.4)).toBe(42);
    expect(parsePercent(-10)).toBe(0);
    expect(parsePercent(900)).toBe(100);
  });

  it("treats nonsense as no progress", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "50", null, {}]) {
      expect(parsePercent(value)).toBe(0);
    }
  });
});

describe("what each state permits", () => {
  const states: readonly UpdateState[] = [
    { status: "disabled", blockers: ["not-release-ready"] },
    { status: "idle", currentVersion: "0.1.0" },
    { status: "checking" },
    { status: "available", version: "0.2.0" },
    { status: "downloading", version: "0.2.0", percent: 10 },
    { status: "downloaded", version: "0.2.0" },
    { status: "error", code: "network" }
  ];

  it("permits nothing at all while disabled", () => {
    const disabled = states[0] as UpdateState;
    expect(canCheck(disabled)).toBe(false);
    expect(canDownload(disabled)).toBe(false);
    expect(canInstall(disabled)).toBe(false);
  });

  it("permits a check only from idle or after an error", () => {
    expect(states.filter(canCheck).map((s) => s.status)).toEqual(["idle", "error"]);
  });

  it("permits a download only when one is available", () => {
    expect(states.filter(canDownload).map((s) => s.status)).toEqual(["available"]);
  });

  it("permits an install only once something is downloaded", () => {
    // Downloading and installing stay separate acts: an updater that installs
    // what it fetched decides when your work is interrupted.
    expect(states.filter(canInstall).map((s) => s.status)).toEqual(["downloaded"]);
  });

  it("covers every shipped status", () => {
    expect(states.map((state) => state.status).sort()).toEqual([...UPDATE_STATUSES].sort());
  });
});

describe("parseUpdateVersionPayload", () => {
  it("accepts a real version", () => {
    expect(parseUpdateVersionPayload({ version: "1.2.3" })).toEqual({ version: "1.2.3" });
  });

  it("refuses anything else", () => {
    for (const hostile of [null, {}, { version: "" }, { version: 42 }, { version: "a b" }]) {
      expect(() => parseUpdateVersionPayload(hostile)).toThrow();
    }
  });
});
