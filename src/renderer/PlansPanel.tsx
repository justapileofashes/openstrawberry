import { Check, Play, X } from "lucide-react";
import type { Plan, PlanStep, StepStatus } from "../shared/orchestration.js";

/**
 * Wording for each step state.
 *
 * `needs-user` and `blocked` read very differently on purpose. One is waiting
 * for the person reading this; the other cannot proceed at all, and offering a
 * decision on it would be offering a choice that changes nothing.
 */
const STEP_TEXT: Readonly<Record<StepStatus, string>> = {
  pending: "Waiting its turn",
  "needs-user": "Waiting for you",
  running: "Running",
  done: "Done",
  failed: "Failed",
  blocked: "Blocked: something it needed did not happen",
  cancelled: "Cancelled"
};

function Step({
  step,
  onDecide
}: {
  readonly step: PlanStep;
  readonly onDecide: (allow: boolean) => void;
}): React.JSX.Element {
  return (
    <li className={`pl-step is-${step.status}`}>
      <div className="pl-step-head">
        <span className="pl-step-title">{step.title}</span>
        <span className="pl-step-status">{STEP_TEXT[step.status]}</span>
      </div>

      {/*
        The grant is shown as a count rather than a list of addresses: what
        matters at review time is how much a step can see, and the addresses are
        already visible in the tab rail.
      */}
      {step.contextTabIds.length > 0 && (
        <p className="pl-step-meta">
          Reads {step.contextTabIds.length}{" "}
          {step.contextTabIds.length === 1 ? "tab" : "tabs"}
        </p>
      )}
      {step.contextTabIds.length === 0 && <p className="pl-step-meta">Reads no tabs</p>}

      {step.status === "needs-user" && (
        <div className="pl-decide">
          <button type="button" className="text-btn" onClick={() => onDecide(true)}>
            Allow
          </button>
          <button type="button" className="text-btn" onClick={() => onDecide(false)}>
            Deny
          </button>
        </div>
      )}

      {/* An artifact is a step's own output, rendered as text and never markup. */}
      {step.artifact !== null && <p className="pl-artifact">{step.artifact}</p>}
    </li>
  );
}

/**
 * Orchestration plans.
 *
 * A plan in `draft` is the review screen: it shows every step, what each one
 * will be allowed to read, and which will stop for a decision — before any of it
 * runs. Approving is the only thing that starts it.
 */
export function PlansPanel({
  plans,
  onApprove,
  onDecide,
  onCancel,
  onClose
}: {
  readonly plans: readonly Plan[];
  readonly onApprove: (planId: string) => void;
  readonly onDecide: (planId: string, stepId: string, allow: boolean) => void;
  readonly onCancel: (planId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="settings glass" role="dialog" aria-label="Plans">
      <header className="set-head">
        <div>
          <span className="eyebrow">Agents</span>
          <h2>Plans</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close plans">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        {plans.length === 0 ? (
          <p className="pl-empty">
            No plans yet. A plan is proposed, reviewed, and only runs once you approve it.
          </p>
        ) : (
          // Newest first, which is the one being reviewed.
          [...plans].reverse().map((plan) => (
            <section key={plan.id} className="pl-plan">
              <div className="pl-plan-head">
                <div>
                  <h3 className="pl-goal">{plan.goal}</h3>
                  <p className="pl-plan-meta">
                    {plan.status} · {plan.steps.length}{" "}
                    {plan.steps.length === 1 ? "step" : "steps"} · {plan.budgetRemaining} left
                    in budget
                  </p>
                </div>

                <div className="pl-plan-actions">
                  {plan.status === "draft" && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onApprove(plan.id)}
                      aria-label={`Approve and run ${plan.goal}`}
                    >
                      <Play size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  )}
                  {(plan.status === "draft" ||
                    plan.status === "approved" ||
                    plan.status === "running") && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onCancel(plan.id)}
                      aria-label={`Cancel ${plan.goal}`}
                    >
                      <X size={14} strokeWidth={1.5} aria-hidden="true" />
                    </button>
                  )}
                  {plan.status === "done" && (
                    <Check size={14} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </div>
              </div>

              {plan.status === "draft" && (
                <p className="set-hint">
                  Nothing here has run. Review what each step will read, then approve.
                </p>
              )}

              <ul className="pl-steps">
                {plan.steps.map((step) => (
                  <Step
                    key={step.id}
                    step={step}
                    onDecide={(allow) => onDecide(plan.id, step.id, allow)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </aside>
  );
}
