/**
 * The typed orchestration graph.
 *
 * A plan is a set of steps with dependencies between them, reviewed by the user
 * before any of it runs. The shape encodes the promises the product makes about
 * agents, so they hold by construction rather than by an executor remembering
 * them:
 *
 *   1. **Review-first is structural.** A plan is built in `draft`, and only a
 *      user's approval moves it to `approved`. Nothing here will hand out a
 *      runnable step from a plan that has not been approved, so an executor
 *      cannot start one by forgetting to check.
 *
 *   2. **Context is granted, not discovered.** A step lists the tab ids it may
 *      read. An empty list means it reads nothing. There is no "all tabs" value
 *      and no way to widen a grant after approval, because the user approved
 *      the plan they were shown.
 *
 *   3. **A cycle is refused at construction.** A plan whose steps depend on each
 *      other in a loop is rejected when it is built, not discovered as a hang
 *      when nothing ever becomes ready.
 *
 *   4. **A budget is spent, not checked.** Every started step draws from a
 *      count the plan carries. When it is exhausted the plan blocks; it does not
 *      keep going and report an overrun afterwards.
 *
 *   5. **A failed dependency blocks, it does not skip.** Work that needed an
 *      earlier result and did not get it is reported as blocked, so the user
 *      sees that something was not done rather than quietly not seeing it.
 *
 * Pure ASCII, and pure functions: a plan is transformed rather than mutated, so
 * every transition is checkable without an executor.
 */

import {
  IpcValidationError,
  requireArray,
  requireIdentifier,
  requireInteger,
  requirePlainObject,
  requireString
} from "./ipc-validation.js";

/** How many steps one plan may hold. Past this it stops being reviewable. */
export const MAX_PLAN_STEPS = 24;

/** How many dependencies one step may name. */
export const MAX_STEP_DEPENDENCIES = 8;

/** How many tabs one step may be granted. */
export const MAX_CONTEXT_GRANT = 16;

export const MAX_STEP_TITLE_LENGTH = 200;

/** The ceiling on a plan's budget, whatever a caller asks for. */
export const MAX_PLAN_BUDGET = 100;

export const PLAN_STATUSES = ["draft", "approved", "running", "done", "failed", "cancelled"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * What a step is doing.
 *
 * `needs-user` and `blocked` are distinct on purpose. One is waiting for a
 * person and will proceed when they answer; the other cannot proceed at all
 * because something it needed did not happen. Collapsing them would offer a
 * decision on work that has no path forward.
 */
export const STEP_STATUSES = [
  "pending",
  "needs-user",
  "running",
  "done",
  "failed",
  "blocked",
  "cancelled"
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  /** The agent that will run it. */
  readonly companionId: string;
  /** Step ids that must finish first. Never contains this step's own id. */
  readonly dependsOn: readonly string[];
  /** Tab ids this step may read. Empty means it reads nothing. */
  readonly contextTabIds: readonly string[];
  /** True when a person must allow it before it starts. */
  readonly requiresApproval: boolean;
  readonly status: StepStatus;
  /** Set once the step produced something. Never carries a credential. */
  readonly artifact: string | null;
}

export interface Plan {
  readonly id: string;
  readonly goal: string;
  readonly status: PlanStatus;
  readonly steps: readonly PlanStep[];
  /** Total starts still available to this plan. */
  readonly budgetRemaining: number;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

export class PlanError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export interface PlanStepDraft {
  readonly id: string;
  readonly title: string;
  readonly companionId: string;
  readonly dependsOn?: readonly string[];
  readonly contextTabIds?: readonly string[];
  readonly requiresApproval?: boolean;
}

/**
 * Detects a cycle, returning true when the steps can be ordered at all.
 *
 * A plain Kahn's-algorithm sweep: repeatedly take everything whose dependencies
 * are already taken. Anything left over is in, or downstream of, a loop.
 */
function isAcyclic(steps: readonly PlanStepDraft[]): boolean {
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn ?? [])]));
  const settled = new Set<string>();

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, dependencies] of remaining) {
      const ready = [...dependencies].every((dependency) => settled.has(dependency));
      if (!ready) continue;
      settled.add(id);
      remaining.delete(id);
      progressed = true;
    }
  }

  return remaining.size === 0;
}

/**
 * Builds a plan in `draft`.
 *
 * Throws rather than returning a partial plan: a plan that cannot be ordered, or
 * that names a step which does not exist, is not something to half-run. The
 * caller shows the error and the user edits the plan.
 */
export function createPlan(input: {
  readonly id: string;
  readonly goal: string;
  readonly steps: readonly PlanStepDraft[];
  readonly budget?: number;
}): Plan {
  if (input.steps.length === 0) throw new PlanError("A plan must have at least one step.");
  if (input.steps.length > MAX_PLAN_STEPS) {
    throw new PlanError(`A plan may have at most ${MAX_PLAN_STEPS} steps.`);
  }

  const ids = new Set<string>();
  for (const step of input.steps) {
    if (ids.has(step.id)) throw new PlanError("Plan step ids must be unique.");
    ids.add(step.id);
  }

  for (const step of input.steps) {
    const dependsOn = step.dependsOn ?? [];
    if (dependsOn.length > MAX_STEP_DEPENDENCIES) {
      throw new PlanError(`A step may depend on at most ${MAX_STEP_DEPENDENCIES} others.`);
    }
    // Self-dependence is a cycle of one, and worth naming as its own mistake.
    if (dependsOn.includes(step.id)) throw new PlanError("A step cannot depend on itself.");

    for (const dependency of dependsOn) {
      if (!ids.has(dependency)) throw new PlanError("A step depends on one that is not here.");
    }

    if ((step.contextTabIds ?? []).length > MAX_CONTEXT_GRANT) {
      throw new PlanError(`A step may be granted at most ${MAX_CONTEXT_GRANT} tabs.`);
    }
  }

  if (!isAcyclic(input.steps)) throw new PlanError("Plan steps depend on each other in a loop.");

  return {
    id: input.id,
    goal: input.goal,
    status: "draft",
    budgetRemaining: Math.min(input.budget ?? input.steps.length, MAX_PLAN_BUDGET),
    steps: input.steps.map((step) => ({
      id: step.id,
      title: step.title,
      companionId: step.companionId,
      dependsOn: [...(step.dependsOn ?? [])],
      contextTabIds: [...(step.contextTabIds ?? [])],
      requiresApproval: step.requiresApproval ?? false,
      status: "pending",
      artifact: null
    }))
  };
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

function withStep(plan: Plan, stepId: string, change: (step: PlanStep) => PlanStep): Plan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? change(step) : step))
  };
}

function stepOf(plan: Plan, stepId: string): PlanStep | null {
  return plan.steps.find((step) => step.id === stepId) ?? null;
}

/** A user's approval. The only way out of `draft`. */
export function approvePlan(plan: Plan): Plan {
  if (plan.status !== "draft") return plan;
  return { ...plan, status: "approved" };
}

export function isTerminalPlanStatus(status: PlanStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return (
    status === "done" || status === "failed" || status === "blocked" || status === "cancelled"
  );
}

/**
 * The steps that could start now.
 *
 * Empty for a plan that has not been approved - which is what makes review-first
 * structural rather than a rule an executor has to remember. Also empty once the
 * budget is spent, so an exhausted plan cannot keep starting work.
 */
export function readySteps(plan: Plan): readonly PlanStep[] {
  if (plan.status !== "approved" && plan.status !== "running") return [];
  if (plan.budgetRemaining <= 0) return [];

  return plan.steps.filter((step) => {
    if (step.status !== "pending") return false;
    return step.dependsOn.every((id) => stepOf(plan, id)?.status === "done");
  });
}

/**
 * Marks what a step needs before it can run.
 *
 * A gated step becomes `needs-user` rather than starting, which is where an
 * approval request is raised from.
 */
export function startStep(plan: Plan, stepId: string): Plan {
  const step = stepOf(plan, stepId);
  if (step === null || step.status !== "pending") return plan;
  if (!readySteps(plan).some((ready) => ready.id === stepId)) return plan;

  if (step.requiresApproval) {
    return withStep({ ...plan, status: "running" }, stepId, (current) => ({
      ...current,
      status: "needs-user"
    }));
  }

  // The budget is spent here, at the start, not checked afterwards.
  return withStep(
    { ...plan, status: "running", budgetRemaining: plan.budgetRemaining - 1 },
    stepId,
    (current) => ({ ...current, status: "running" })
  );
}

/** Records a decision on a gated step. A denial fails it rather than retrying. */
export function resolveStepApproval(plan: Plan, stepId: string, allow: boolean): Plan {
  const step = stepOf(plan, stepId);
  if (step === null || step.status !== "needs-user") return plan;

  /*
   * Both endings below go through `blockUnreachable` before settling, for the
   * same reason `completeStep` does: a step that will now never finish strands
   * everything downstream of it. Failing one without propagating leaves those
   * dependents `pending` forever - nothing can make them ready, and `settle`
   * sees live work, so the plan never reaches a terminal state and simply
   * hangs. A denial has to end the plan as decisively as a failure does.
   */
  if (!allow) {
    return settle(
      blockUnreachable(withStep(plan, stepId, (c) => ({ ...c, status: "failed" })))
    );
  }

  if (plan.budgetRemaining <= 0) {
    return settle(
      blockUnreachable(withStep(plan, stepId, (c) => ({ ...c, status: "blocked" })))
    );
  }

  return withStep({ ...plan, budgetRemaining: plan.budgetRemaining - 1 }, stepId, (current) => ({
    ...current,
    status: "running"
  }));
}

/**
 * Records a step's outcome, then propagates.
 *
 * Anything that depended on a step which did not finish becomes `blocked`, so
 * work that was not done is visible rather than absent.
 */
export function completeStep(
  plan: Plan,
  stepId: string,
  outcome: { readonly ok: true; readonly artifact: string | null } | { readonly ok: false }
): Plan {
  const step = stepOf(plan, stepId);
  if (step === null || step.status !== "running") return plan;

  const updated = withStep(plan, stepId, (current) => ({
    ...current,
    status: outcome.ok ? "done" : "failed",
    artifact: outcome.ok ? outcome.artifact : null
  }));

  return settle(blockUnreachable(updated));
}

/** Cancels everything not already finished. */
export function cancelPlan(plan: Plan): Plan {
  if (isTerminalPlanStatus(plan.status)) return plan;

  return {
    ...plan,
    status: "cancelled",
    steps: plan.steps.map((step) =>
      isTerminalStepStatus(step.status) ? step : { ...step, status: "cancelled" }
    )
  };
}

/**
 * Blocks whatever can no longer run.
 *
 * Repeated to a fixed point, because blocking one step can strand the steps that
 * depended on it in turn.
 */
function blockUnreachable(plan: Plan): Plan {
  let current = plan;

  for (let pass = 0; pass < MAX_PLAN_STEPS; pass += 1) {
    let changed = false;

    const steps = current.steps.map((step) => {
      if (step.status !== "pending") return step;

      const stranded = step.dependsOn.some((id) => {
        const dependency = current.steps.find((candidate) => candidate.id === id);
        return dependency !== undefined && isTerminalStepStatus(dependency.status) && dependency.status !== "done";
      });

      if (!stranded) return step;
      changed = true;
      return { ...step, status: "blocked" as StepStatus };
    });

    current = { ...current, steps };
    if (!changed) break;
  }

  return current;
}

/** Moves the plan to a terminal state once nothing can advance. */
function settle(plan: Plan): Plan {
  if (isTerminalPlanStatus(plan.status)) return plan;

  const anyLive = plan.steps.some((step) => !isTerminalStepStatus(step.status));
  if (anyLive) return plan;

  const anyBad = plan.steps.some(
    (step) => step.status === "failed" || step.status === "blocked"
  );

  return { ...plan, status: anyBad ? "failed" : "done" };
}

/**
 * The tabs a step may read.
 *
 * The grant is intersected with what is actually open, so a tab closed between
 * approval and execution is simply not read - a plan cannot reach a tab by
 * naming one that has since become something else.
 */
export function grantedContext(
  step: PlanStep,
  openTabIds: readonly string[]
): readonly string[] {
  const open = new Set(openTabIds);
  return step.contextTabIds.filter((id) => open.has(id)).slice(0, MAX_CONTEXT_GRANT);
}

/* -------------------------------------------------------------------------- */
/* Payload validation                                                          */
/* -------------------------------------------------------------------------- */

export interface PlanDraftPayload {
  readonly goal: string;
  readonly steps: readonly PlanStepDraft[];
}

/**
 * Validates a plan the renderer proposed.
 *
 * Ids are validated as identifiers rather than minted here, because a draft's
 * steps refer to each other by name and the renderer has to be able to express
 * that. They are checked for uniqueness and resolvability by `createPlan`, so a
 * renderer-chosen id cannot address anything outside its own plan.
 */
export function parsePlanDraftPayload(raw: unknown): PlanDraftPayload {
  const root = requirePlainObject(raw, "Plan");
  const rawSteps = requireArray(root["steps"], "Plan steps", MAX_PLAN_STEPS);

  const steps: PlanStepDraft[] = rawSteps.map((entry) => {
    const step = requirePlainObject(entry, "Plan step");

    const dependsOn = requireArray(
      step["dependsOn"] ?? [],
      "Step dependencies",
      MAX_STEP_DEPENDENCIES
    ).map((value) => requireIdentifier(value, "Step dependency"));

    const contextTabIds = requireArray(
      step["contextTabIds"] ?? [],
      "Step context",
      MAX_CONTEXT_GRANT
    ).map((value) => requireIdentifier(value, "Step context tab"));

    const requiresApproval = step["requiresApproval"];
    if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") {
      throw new IpcValidationError("Step approval must be a boolean.");
    }

    return {
      id: requireIdentifier(step["id"], "Step ID"),
      title: requireString(step["title"], "Step title", MAX_STEP_TITLE_LENGTH),
      companionId: requireIdentifier(step["companionId"], "Step agent"),
      dependsOn,
      contextTabIds,
      requiresApproval: requiresApproval === true
    };
  });

  return {
    goal: requireString(root["goal"], "Plan goal", MAX_STEP_TITLE_LENGTH),
    steps
  };
}

export interface PlanIdPayload {
  readonly planId: string;
}

export function parsePlanIdPayload(raw: unknown): PlanIdPayload {
  const root = requirePlainObject(raw, "Plan request");
  return { planId: requireIdentifier(root["planId"], "Plan ID") };
}

export interface PlanDecisionPayload {
  readonly planId: string;
  readonly stepId: string;
  readonly allow: boolean;
}

/**
 * A decision on a gated step.
 *
 * `allow` is required to be a boolean rather than read for truthiness: a payload
 * that omitted it must not read as permission.
 */
export function parsePlanDecisionPayload(raw: unknown): PlanDecisionPayload {
  const root = requirePlainObject(raw, "Plan decision");
  const allow = root["allow"];
  if (typeof allow !== "boolean") {
    throw new IpcValidationError("Plan decision must be a boolean.");
  }

  return {
    planId: requireIdentifier(root["planId"], "Plan ID"),
    stepId: requireIdentifier(root["stepId"], "Step ID"),
    allow
  };
}

export interface PlanStepPayload {
  readonly planId: string;
  readonly stepId: string;
}

export function parsePlanStepPayload(raw: unknown): PlanStepPayload {
  const root = requirePlainObject(raw, "Plan step request");
  return {
    planId: requireIdentifier(root["planId"], "Plan ID"),
    stepId: requireIdentifier(root["stepId"], "Step ID")
  };
}

export function parsePlanBudget(raw: unknown): number {
  return requireInteger(raw, "Plan budget", 1, MAX_PLAN_BUDGET);
}
