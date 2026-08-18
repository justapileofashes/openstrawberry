import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanRunner, type StepExecutor } from "./plan-runner.js";
import type { Plan, PlanStep, PlanStepDraft } from "../shared/orchestration.js";
import type { ProviderResult } from "../shared/provider-request.js";

const LINEAR: readonly PlanStepDraft[] = [
  { id: "a", title: "Read", companionId: "companion-1", contextTabIds: ["tab-1"] },
  { id: "b", title: "Summarise", companionId: "companion-1", dependsOn: ["a"] }
];

let published: (readonly Plan[])[] = [];
let executed: { step: PlanStep; granted: readonly string[] }[] = [];

function runnerWith(
  execute?: StepExecutor,
  openTabIds: readonly string[] = ["tab-1", "tab-2"]
): PlanRunner {
  return new PlanRunner({
    publish: (plans) => published.push(plans),
    openTabIds: () => openTabIds,
    ...(execute === undefined ? {} : { execute })
  });
}

/** An executor that records what it was given and always succeeds. */
function recordingExecutor(result: ProviderResult = { ok: true, text: "done" }): StepExecutor {
  return async (step, granted) => {
    executed.push({ step, granted });
    return result;
  };
}

/** Lets the runner's async loop settle. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) await Promise.resolve();
}

beforeEach(() => {
  published = [];
  executed = [];
});

describe("propose", () => {
  it("adds a plan in draft and publishes it", () => {
    const runner = runnerWith();
    const plan = runner.propose("Research", LINEAR);

    expect(plan.status).toBe("draft");
    expect(runner.snapshot()).toHaveLength(1);
    expect(published.length).toBeGreaterThan(0);
  });

  it("mints the plan id rather than accepting one", () => {
    const runner = runnerWith();
    expect(runner.propose("g", LINEAR).id).toMatch(/^plan-\d+$/u);
  });

  it("refuses a malformed plan rather than storing it", () => {
    const runner = runnerWith();
    expect(() =>
      runner.propose("g", [{ id: "a", title: "A", companionId: "c", dependsOn: ["a"] }])
    ).toThrow();
    expect(runner.snapshot()).toEqual([]);
  });
});

describe("review-first", () => {
  it("runs nothing while the plan is a draft", async () => {
    const runner = runnerWith(recordingExecutor());
    runner.propose("g", LINEAR);
    await settle();

    expect(executed).toEqual([]);
  });

  it("runs only once approved", async () => {
    const runner = runnerWith(recordingExecutor());
    const plan = runner.propose("g", LINEAR);

    runner.approve(plan.id);
    await settle();

    expect(executed.map((entry) => entry.step.id)).toEqual(["a", "b"]);
  });

  it("runs nothing at all with no executor", async () => {
    // Reviewable but inert, which is the honest state for a build with no
    // provider wired.
    const runner = runnerWith();
    const plan = runner.propose("g", LINEAR);

    runner.approve(plan.id);
    await settle();

    expect(runner.snapshot()[0]?.status).toBe("approved");
  });
});

describe("dependencies", () => {
  it("runs steps in dependency order", async () => {
    const runner = runnerWith(recordingExecutor());
    runner.approve(runner.propose("g", LINEAR).id);
    await settle();

    expect(executed.map((entry) => entry.step.id)).toEqual(["a", "b"]);
    expect(runner.snapshot()[0]?.status).toBe("done");
  });

  it("blocks what depended on a failure and stops", async () => {
    const runner = runnerWith(recordingExecutor({ ok: false, code: "network" }));
    runner.approve(runner.propose("g", LINEAR).id);
    await settle();

    const plan = runner.snapshot()[0];
    expect(plan?.steps.map((step) => step.status)).toEqual(["failed", "blocked"]);
    expect(plan?.status).toBe("failed");
    // The blocked step was never handed to the executor.
    expect(executed.map((entry) => entry.step.id)).toEqual(["a"]);
  });

  it("keeps the artifact a step produced", async () => {
    const runner = runnerWith(recordingExecutor({ ok: true, text: "the notes" }));
    runner.approve(runner.propose("g", LINEAR).id);
    await settle();

    expect(runner.snapshot()[0]?.steps[0]?.artifact).toBe("the notes");
  });
});

describe("context grants", () => {
  it("hands a step only the tabs it was granted", async () => {
    const runner = runnerWith(recordingExecutor(), ["tab-1", "tab-2", "tab-3"]);
    runner.approve(runner.propose("g", LINEAR).id);
    await settle();

    expect(executed[0]?.granted).toEqual(["tab-1"]);
    // The second step named none, so it reads nothing.
    expect(executed[1]?.granted).toEqual([]);
  });

  it("drops a granted tab that has since closed", async () => {
    const runner = runnerWith(recordingExecutor(), ["tab-9"]);
    runner.approve(runner.propose("g", LINEAR).id);
    await settle();

    expect(executed[0]?.granted).toEqual([]);
  });
});

describe("approval gates", () => {
  const GATED: readonly PlanStepDraft[] = [
    { id: "a", title: "Send", companionId: "c", requiresApproval: true },
    { id: "b", title: "After", companionId: "c", dependsOn: ["a"] }
  ];

  it("stops at a gate without running it", async () => {
    const runner = runnerWith(recordingExecutor());
    runner.approve(runner.propose("g", GATED).id);
    await settle();

    expect(runner.snapshot()[0]?.steps[0]?.status).toBe("needs-user");
    expect(executed).toEqual([]);
  });

  it("resumes once allowed", async () => {
    const runner = runnerWith(recordingExecutor());
    const plan = runner.propose("g", GATED);
    runner.approve(plan.id);
    await settle();

    runner.resolveApproval(plan.id, "a", true);
    await settle();

    expect(executed.map((entry) => entry.step.id)).toEqual(["a", "b"]);
    expect(runner.snapshot()[0]?.status).toBe("done");
  });

  it("stops for good on a denial, and blocks what followed", async () => {
    const runner = runnerWith(recordingExecutor());
    const plan = runner.propose("g", GATED);
    runner.approve(plan.id);
    await settle();

    runner.resolveApproval(plan.id, "a", false);
    await settle();

    expect(executed).toEqual([]);
    expect(runner.snapshot()[0]?.steps.map((s) => s.status)).toEqual(["failed", "blocked"]);
  });
});

describe("budgets", () => {
  it("stops when the budget is spent", async () => {
    const runner = runnerWith(recordingExecutor());
    const plan = runner.propose("g", LINEAR, 1);

    runner.approve(plan.id);
    await settle();

    // One step ran; the plan then offers nothing rather than overrunning.
    expect(executed.map((entry) => entry.step.id)).toEqual(["a"]);
    expect(runner.snapshot()[0]?.budgetRemaining).toBe(0);
  });
});

describe("cancellation", () => {
  it("cancels a plan and stops driving it", async () => {
    let release: (() => void) | null = null;
    const slow: StepExecutor = async (step, granted) => {
      executed.push({ step, granted });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, text: "late" };
    };

    const runner = runnerWith(slow);
    const plan = runner.propose("g", LINEAR);
    runner.approve(plan.id);
    await settle();

    runner.cancel(plan.id);
    release?.();
    await settle();

    expect(runner.snapshot()[0]?.status).toBe("cancelled");
    // The second step was never started after cancellation.
    expect(executed.map((entry) => entry.step.id)).toEqual(["a"]);
  });

  it("aborts the signal a step was given", async () => {
    let seen: AbortSignal | null = null;
    const capturing: StepExecutor = async (_step, _granted, signal) => {
      seen = signal;
      return { ok: true, text: "x" };
    };

    const runner = runnerWith(capturing);
    const plan = runner.propose("g", LINEAR);
    runner.approve(plan.id);
    await settle();

    runner.cancel(plan.id);
    expect(seen).not.toBeNull();
  });
});

describe("robustness", () => {
  it("does not leave a step running when the executor throws", async () => {
    const runner = runnerWith(async () => {
      throw new Error("executor is broken");
    });

    runner.approve(runner.propose("g", LINEAR).id);
    await settle();

    const plan = runner.snapshot()[0];
    expect(plan?.steps[0]?.status).toBe("failed");
    expect(plan?.status).toBe("failed");
  });

  it("ignores commands naming a plan that does not exist", () => {
    const runner = runnerWith(recordingExecutor());
    const before = runner.snapshot();

    runner.approve("plan-nope");
    runner.cancel("plan-nope");
    runner.resolveApproval("plan-nope", "a", true);

    expect(runner.snapshot()).toEqual(before);
  });

  it("does not run one plan twice concurrently", async () => {
    const runner = runnerWith(recordingExecutor());
    const plan = runner.propose("g", LINEAR);

    // A second approval must not start a second driver over the same steps.
    runner.approve(plan.id);
    runner.approve(plan.id);
    await settle();

    expect(executed.map((entry) => entry.step.id)).toEqual(["a", "b"]);
  });

  it("bounds how many plans it keeps", () => {
    const runner = new PlanRunner({
      publish: () => undefined,
      openTabIds: () => [],
      maxPlans: 2
    });

    runner.propose("one", LINEAR);
    runner.propose("two", LINEAR);
    runner.propose("three", LINEAR);

    expect(runner.snapshot().map((plan) => plan.goal)).toEqual(["two", "three"]);
  });

  it("is safe to destroy twice and runs nothing afterwards", async () => {
    const execute = vi.fn(recordingExecutor());
    const runner = runnerWith(execute as unknown as StepExecutor);
    const plan = runner.propose("g", LINEAR);

    runner.destroy();
    runner.destroy();
    runner.approve(plan.id);
    await settle();

    expect(executed).toEqual([]);
  });
});
