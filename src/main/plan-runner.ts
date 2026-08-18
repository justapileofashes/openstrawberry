/**
 * Drives an orchestration plan.
 *
 * All the rules live in `../shared/orchestration.js` as pure transitions. This
 * class owns only the parts that cannot be pure: holding plans, calling out to
 * execute a step, and pushing state so the panel can render it.
 *
 * That split is what makes the safety properties checkable. This runner cannot
 * start a step the graph did not offer, because the only way it obtains one is
 * `readySteps`, which returns nothing for an unapproved plan, nothing once the
 * budget is spent, and nothing whose dependencies have not finished. There is no
 * second path into execution here to keep consistent with the first.
 *
 * The executor is injected. With none, plans can be proposed, reviewed, approved
 * and cancelled, and simply never run - which is the honest state for a build
 * with no provider wired, and keeps these tests from calling anything real.
 */
import {
  approvePlan,
  cancelPlan,
  completeStep,
  createPlan,
  grantedContext,
  isTerminalPlanStatus,
  readySteps,
  resolveStepApproval,
  startStep,
  type Plan,
  type PlanStep,
  type PlanStepDraft
} from "../shared/orchestration.js";
import type { ProviderResult } from "../shared/provider-request.js";

/**
 * Runs one step.
 *
 * Receives the step and the tabs it was actually granted, already intersected
 * with what is open. It is given no way to ask for more: widening a grant would
 * mean running something other than what the user approved.
 */
export type StepExecutor = (
  step: PlanStep,
  contextTabIds: readonly string[],
  signal: AbortSignal
) => Promise<ProviderResult>;

export interface PlanRunnerOptions {
  readonly publish: (plans: readonly Plan[]) => void;
  /** Tab ids currently open, read fresh for every step. */
  readonly openTabIds: () => readonly string[];
  /** Absent means plans are reviewable but never run. */
  readonly execute?: StepExecutor;
  /** How many plans are kept. Older ones fall off the end. */
  readonly maxPlans?: number;
}

const DEFAULT_MAX_PLANS = 10;

export class PlanRunner {
  private readonly publish: (plans: readonly Plan[]) => void;
  private readonly openTabIds: () => readonly string[];
  private readonly execute: StepExecutor | null;
  private readonly maxPlans: number;

  private plans: readonly Plan[] = [];
  private nextSequence = 1;
  private readonly inFlight = new Map<string, AbortController>();
  private destroyed = false;

  public constructor(options: PlanRunnerOptions) {
    this.publish = options.publish;
    this.openTabIds = options.openTabIds;
    this.execute = options.execute ?? null;
    this.maxPlans = options.maxPlans ?? DEFAULT_MAX_PLANS;
  }

  public snapshot(): readonly Plan[] {
    return this.plans;
  }

  /**
   * Adds a plan for review.
   *
   * Throws whatever `createPlan` throws - a cycle, a dangling dependency, a
   * plan past the bounds - so a malformed proposal is refused rather than
   * stored in a state nothing can run.
   */
  public propose(goal: string, steps: readonly PlanStepDraft[], budget?: number): Plan {
    const plan = createPlan({
      // Minted here, so every plan handle is one the trusted process issued.
      id: `plan-${this.nextSequence++}`,
      goal,
      steps,
      ...(budget === undefined ? {} : { budget })
    });

    this.plans = [...this.plans, plan].slice(-this.maxPlans);
    this.emit();
    return plan;
  }

  /** A user's approval, which is the only thing that makes a plan runnable. */
  public approve(planId: string): void {
    this.replace(planId, approvePlan);
    void this.drive(planId);
  }

  public resolveApproval(planId: string, stepId: string, allow: boolean): void {
    this.replace(planId, (plan) => resolveStepApproval(plan, stepId, allow));

    // An allowed step is now running and needs executing; a denial may have
    // finished the plan. Driving handles both.
    void this.drive(planId);
  }

  public cancel(planId: string): void {
    this.inFlight.get(planId)?.abort();
    this.inFlight.delete(planId);
    this.replace(planId, cancelPlan);
  }

  /** Safe to call twice, and safe once the window has begun closing. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
  }

  /* --------------------------------------------------------------------- */
  /* Driving                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * Runs whatever the plan currently offers, until it offers nothing.
   *
   * Re-reads the plan on every pass rather than iterating a list captured at the
   * start: a step finishing can make others ready, an approval can arrive
   * mid-flight, and the budget can run out. Asking the graph again each time is
   * what keeps this runner from acting on a plan that has moved on.
   */
  private async drive(planId: string): Promise<void> {
    if (this.execute === null) return;

    // One driver per plan. A second would run the same ready step twice.
    if (this.inFlight.has(planId)) return;

    const controller = new AbortController();
    this.inFlight.set(planId, controller);

    try {
      for (;;) {
        if (this.destroyed || controller.signal.aborted) return;

        const plan = this.planOf(planId);
        if (plan === null || isTerminalPlanStatus(plan.status)) return;

        // A step already running was started by an approval rather than by this
        // loop, so it is picked up here rather than left waiting.
        const running = plan.steps.find((step) => step.status === "running");
        const next = running ?? readySteps(plan).at(0);
        if (next === undefined) return;

        const started = running === undefined ? startStep(plan, next.id) : plan;
        this.replace(planId, () => started);

        // A gate stops the loop. It resumes when the decision arrives.
        const afterStart = this.planOf(planId);
        const step = afterStart?.steps.find((candidate) => candidate.id === next.id);
        if (step === undefined || step.status !== "running") return;

        const granted = grantedContext(step, this.openTabIds());

        let result: ProviderResult;
        try {
          result = await this.execute(step, granted, controller.signal);
        } catch {
          // A broken executor must not leave a step running forever.
          result = { ok: false, code: "command-failed" };
        }

        if (this.destroyed || controller.signal.aborted) return;

        this.replace(planId, (current) =>
          completeStep(
            current,
            step.id,
            result.ok ? { ok: true, artifact: result.text } : { ok: false }
          )
        );
      }
    } finally {
      this.inFlight.delete(planId);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  private planOf(planId: string): Plan | null {
    return this.plans.find((plan) => plan.id === planId) ?? null;
  }

  private replace(planId: string, change: (plan: Plan) => Plan): void {
    let changed = false;

    const next = this.plans.map((plan) => {
      if (plan.id !== planId) return plan;
      changed = true;
      return change(plan);
    });

    if (!changed) return;
    this.plans = next;
    this.emit();
  }

  private emit(): void {
    if (!this.destroyed) this.publish(this.plans);
  }
}
