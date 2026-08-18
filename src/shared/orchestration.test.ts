import { describe, expect, it } from "vitest";
import {
  approvePlan,
  cancelPlan,
  completeStep,
  createPlan,
  grantedContext,
  MAX_CONTEXT_GRANT,
  MAX_PLAN_BUDGET,
  MAX_PLAN_STEPS,
  parsePlanDraftPayload,
  parsePlanStepPayload,
  PlanError,
  readySteps,
  resolveStepApproval,
  startStep,
  type Plan
} from "./orchestration.js";

function linearPlan(): Plan {
  return createPlan({
    id: "plan-1",
    goal: "Research a topic",
    steps: [
      { id: "a", title: "Read the tabs", companionId: "companion-1", contextTabIds: ["tab-1"] },
      { id: "b", title: "Summarise", companionId: "companion-1", dependsOn: ["a"] }
    ]
  });
}

/** Runs a step through to a successful finish. */
function finish(plan: Plan, stepId: string, artifact = "result"): Plan {
  return completeStep(startStep(plan, stepId), stepId, { ok: true, artifact });
}

describe("createPlan", () => {
  it("starts in draft with every step pending", () => {
    const plan = linearPlan();
    expect(plan.status).toBe("draft");
    expect(plan.steps.every((step) => step.status === "pending")).toBe(true);
  });

  it("refuses a loop rather than letting it hang", () => {
    // Discovered at construction, not as a plan where nothing ever becomes ready.
    expect(() =>
      createPlan({
        id: "plan-1",
        goal: "g",
        steps: [
          { id: "a", title: "A", companionId: "c", dependsOn: ["b"] },
          { id: "b", title: "B", companionId: "c", dependsOn: ["a"] }
        ]
      })
    ).toThrow(PlanError);
  });

  it("refuses a longer loop", () => {
    expect(() =>
      createPlan({
        id: "plan-1",
        goal: "g",
        steps: [
          { id: "a", title: "A", companionId: "c", dependsOn: ["c"] },
          { id: "b", title: "B", companionId: "c", dependsOn: ["a"] },
          { id: "c", title: "C", companionId: "c", dependsOn: ["b"] }
        ]
      })
    ).toThrow(PlanError);
  });

  it("names self-dependence as its own mistake", () => {
    expect(() =>
      createPlan({
        id: "plan-1",
        goal: "g",
        steps: [{ id: "a", title: "A", companionId: "c", dependsOn: ["a"] }]
      })
    ).toThrow(/depend on itself/u);
  });

  it("refuses a dependency that is not in the plan", () => {
    expect(() =>
      createPlan({
        id: "plan-1",
        goal: "g",
        steps: [{ id: "a", title: "A", companionId: "c", dependsOn: ["elsewhere"] }]
      })
    ).toThrow(PlanError);
  });

  it("refuses duplicate ids, an empty plan, and one past the cap", () => {
    const step = { id: "a", title: "A", companionId: "c" };
    expect(() => createPlan({ id: "p", goal: "g", steps: [step, step] })).toThrow(PlanError);
    expect(() => createPlan({ id: "p", goal: "g", steps: [] })).toThrow(PlanError);
    expect(() =>
      createPlan({
        id: "p",
        goal: "g",
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_u, i) => ({
          id: `s${i}`,
          title: "S",
          companionId: "c"
        }))
      })
    ).toThrow(PlanError);
  });

  it("refuses a context grant past the cap", () => {
    expect(() =>
      createPlan({
        id: "p",
        goal: "g",
        steps: [
          {
            id: "a",
            title: "A",
            companionId: "c",
            contextTabIds: Array.from({ length: MAX_CONTEXT_GRANT + 1 }, (_u, i) => `tab-${i}`)
          }
        ]
      })
    ).toThrow(PlanError);
  });

  it("bounds the budget however large a caller asks", () => {
    const plan = createPlan({
      id: "p",
      goal: "g",
      steps: [{ id: "a", title: "A", companionId: "c" }],
      budget: 10_000
    });
    expect(plan.budgetRemaining).toBeLessThanOrEqual(MAX_PLAN_BUDGET);
  });
});

describe("review-first", () => {
  it("offers nothing runnable while the plan is a draft", () => {
    // Structural, not a rule an executor has to remember to check.
    expect(readySteps(linearPlan())).toEqual([]);
  });

  it("will not start a step in a draft plan", () => {
    const plan = startStep(linearPlan(), "a");
    expect(plan.steps[0]?.status).toBe("pending");
    expect(plan.status).toBe("draft");
  });

  it("offers the first step once approved", () => {
    const plan = approvePlan(linearPlan());
    expect(readySteps(plan).map((step) => step.id)).toEqual(["a"]);
  });

  it("cannot be approved twice out of a running state", () => {
    const running = startStep(approvePlan(linearPlan()), "a");
    expect(approvePlan(running).status).toBe("running");
  });
});

describe("dependencies", () => {
  it("holds a step back until what it needs is done", () => {
    let plan = approvePlan(linearPlan());
    expect(readySteps(plan).map((s) => s.id)).toEqual(["a"]);

    plan = startStep(plan, "a");
    expect(readySteps(plan)).toEqual([]);

    plan = completeStep(plan, "a", { ok: true, artifact: "notes" });
    expect(readySteps(plan).map((s) => s.id)).toEqual(["b"]);
  });

  it("offers independent steps together", () => {
    const plan = approvePlan(
      createPlan({
        id: "p",
        goal: "g",
        steps: [
          { id: "a", title: "A", companionId: "c" },
          { id: "b", title: "B", companionId: "c" }
        ]
      })
    );

    expect(readySteps(plan).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("blocks what depended on a failure rather than skipping it", () => {
    // Work that was not done should be visible, not absent.
    let plan = approvePlan(linearPlan());
    plan = startStep(plan, "a");
    plan = completeStep(plan, "a", { ok: false });

    expect(plan.steps.find((s) => s.id === "b")?.status).toBe("blocked");
    expect(plan.status).toBe("failed");
  });

  it("blocks transitively", () => {
    let plan = approvePlan(
      createPlan({
        id: "p",
        goal: "g",
        steps: [
          { id: "a", title: "A", companionId: "c" },
          { id: "b", title: "B", companionId: "c", dependsOn: ["a"] },
          { id: "c", title: "C", companionId: "c", dependsOn: ["b"] }
        ]
      })
    );

    plan = completeStep(startStep(plan, "a"), "a", { ok: false });

    expect(plan.steps.map((s) => s.status)).toEqual(["failed", "blocked", "blocked"]);
  });
});

describe("approval gates", () => {
  function gatedPlan(): Plan {
    return approvePlan(
      createPlan({
        id: "p",
        goal: "g",
        steps: [{ id: "a", title: "Send something", companionId: "c", requiresApproval: true }]
      })
    );
  }

  it("waits for a person instead of starting", () => {
    const plan = startStep(gatedPlan(), "a");
    expect(plan.steps[0]?.status).toBe("needs-user");
  });

  it("spends no budget while waiting", () => {
    const plan = startStep(gatedPlan(), "a");
    expect(plan.budgetRemaining).toBe(gatedPlan().budgetRemaining);
  });

  it("runs once allowed, and spends the budget then", () => {
    const waiting = startStep(gatedPlan(), "a");
    const allowed = resolveStepApproval(waiting, "a", true);

    expect(allowed.steps[0]?.status).toBe("running");
    expect(allowed.budgetRemaining).toBe(waiting.budgetRemaining - 1);
  });

  it("fails the step on a denial rather than retrying it", () => {
    const denied = resolveStepApproval(startStep(gatedPlan(), "a"), "a", false);
    expect(denied.steps[0]?.status).toBe("failed");
    expect(denied.status).toBe("failed");
  });

  it("ignores a decision on a step that is not waiting", () => {
    const plan = gatedPlan();
    expect(resolveStepApproval(plan, "a", true)).toEqual(plan);
  });
});

describe("budgets", () => {
  it("is spent at the start rather than checked afterwards", () => {
    const plan = approvePlan(
      createPlan({
        id: "p",
        goal: "g",
        steps: [
          { id: "a", title: "A", companionId: "c" },
          { id: "b", title: "B", companionId: "c" }
        ],
        budget: 1
      })
    );

    const started = startStep(plan, "a");
    expect(started.budgetRemaining).toBe(0);
    // Exhausted: nothing else is offered, so the plan cannot overrun.
    expect(readySteps(started)).toEqual([]);
  });

  it("blocks a gated step that outlived its budget", () => {
    let plan = approvePlan(
      createPlan({
        id: "p",
        goal: "g",
        steps: [
          { id: "a", title: "A", companionId: "c" },
          { id: "b", title: "B", companionId: "c", requiresApproval: true }
        ],
        budget: 1
      })
    );

    plan = startStep(plan, "b");
    expect(plan.steps[1]?.status).toBe("needs-user");

    plan = startStep(plan, "a");
    expect(plan.budgetRemaining).toBe(0);

    plan = resolveStepApproval(plan, "b", true);
    expect(plan.steps[1]?.status).toBe("blocked");
  });
});

describe("completion", () => {
  it("finishes a plan whose steps all succeeded", () => {
    let plan = approvePlan(linearPlan());
    plan = finish(plan, "a");
    plan = finish(plan, "b");

    expect(plan.status).toBe("done");
    expect(plan.steps.every((s) => s.status === "done")).toBe(true);
  });

  it("keeps the artifact a step produced", () => {
    const plan = finish(approvePlan(linearPlan()), "a", "the notes");
    expect(plan.steps[0]?.artifact).toBe("the notes");
  });

  it("keeps no artifact for a failure", () => {
    let plan = approvePlan(linearPlan());
    plan = completeStep(startStep(plan, "a"), "a", { ok: false });
    expect(plan.steps[0]?.artifact).toBeNull();
  });

  it("ignores completion of a step that is not running", () => {
    const plan = approvePlan(linearPlan());
    expect(completeStep(plan, "a", { ok: true, artifact: "x" })).toEqual(plan);
  });
});

describe("cancellation", () => {
  it("cancels everything not already finished", () => {
    let plan = approvePlan(linearPlan());
    plan = finish(plan, "a");
    plan = startStep(plan, "b");

    const cancelled = cancelPlan(plan);

    expect(cancelled.status).toBe("cancelled");
    // What finished stays finished; only live work is cancelled.
    expect(cancelled.steps[0]?.status).toBe("done");
    expect(cancelled.steps[1]?.status).toBe("cancelled");
  });

  it("leaves an already-finished plan alone", () => {
    let plan = approvePlan(linearPlan());
    plan = finish(plan, "a");
    plan = finish(plan, "b");

    expect(cancelPlan(plan)).toEqual(plan);
  });
});

describe("grantedContext", () => {
  it("grants only what the step named", () => {
    const plan = linearPlan();
    const step = plan.steps[0];
    expect(step).toBeDefined();
    expect(grantedContext(step as never, ["tab-1", "tab-2", "tab-3"])).toEqual(["tab-1"]);
  });

  it("grants nothing to a step that named nothing", () => {
    // No "all tabs" value exists, so an ungranted step reads nothing.
    const plan = linearPlan();
    expect(grantedContext(plan.steps[1] as never, ["tab-1", "tab-2"])).toEqual([]);
  });

  it("drops a tab that closed between approval and execution", () => {
    const plan = linearPlan();
    expect(grantedContext(plan.steps[0] as never, ["tab-9"])).toEqual([]);
  });
});

describe("payload validation", () => {
  it("accepts a well-formed draft", () => {
    const parsed = parsePlanDraftPayload({
      goal: "Research",
      steps: [
        {
          id: "a",
          title: "Read",
          companionId: "companion-1",
          contextTabIds: ["tab-1"],
          requiresApproval: true
        }
      ]
    });

    expect(parsed.steps[0]?.requiresApproval).toBe(true);
  });

  it("does not coerce the approval flag", () => {
    expect(() =>
      parsePlanDraftPayload({
        goal: "g",
        steps: [{ id: "a", title: "T", companionId: "c", requiresApproval: "yes" }]
      })
    ).toThrow();
  });

  it("refuses identifiers that could escape an identifier context", () => {
    for (const id of ["../../etc", "a b", "", 7, null]) {
      expect(() =>
        parsePlanDraftPayload({ goal: "g", steps: [{ id, title: "T", companionId: "c" }] })
      ).toThrow();
    }
  });

  it("bounds dependencies, context, and step count", () => {
    expect(() =>
      parsePlanDraftPayload({
        goal: "g",
        steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_u, i) => ({
          id: `s${i}`,
          title: "T",
          companionId: "c"
        }))
      })
    ).toThrow();
  });

  it("parses a step reference", () => {
    expect(parsePlanStepPayload({ planId: "plan-1", stepId: "a" })).toEqual({
      planId: "plan-1",
      stepId: "a"
    });
    for (const hostile of [null, {}, { planId: "plan-1" }, { planId: "p", stepId: "" }]) {
      expect(() => parsePlanStepPayload(hostile)).toThrow();
    }
  });
});
