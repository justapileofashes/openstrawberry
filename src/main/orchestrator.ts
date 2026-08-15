/* OpenStrawberry orchestration foundation: task graphs remain visible and require user approval before any execution adapter is invoked. */
import { randomUUID } from "node:crypto";
import type { AgentRole } from "../shared/agent.js";
import type { OrchestrationPlan, OrchestrationRequest, OrchestrationStep } from "../shared/orchestration.js";

export function createOrchestrationPlan(request: OrchestrationRequest): OrchestrationPlan {
  const objective = request.objective.trim() || "Coordinate the selected browser context";
  const available = new Set<AgentRole>(request.availableRoles);
  const candidates: Array<Pick<OrchestrationStep, "agentId" | "role" | "title" | "contextPolicy">> = [
    { agentId: "researcher", role: "researcher", title: "Collect and normalize selected-tab evidence", contextPolicy: "selected-tabs" },
    { agentId: "coder", role: "coder", title: "Prepare an isolated implementation artifact", contextPolicy: "artifact-only" },
    { agentId: "reviewer", role: "reviewer", title: "Review the artifact and return an approval summary", contextPolicy: "artifact-only" }
  ];
  const sequence = candidates.filter((step) => available.has(step.role));
  const steps: OrchestrationStep[] = sequence.map((step, index) => ({ ...step, id: `${step.role}-${index + 1}`, dependsOn: index === 0 ? [] : [sequence[index - 1].role + "-" + index], state: "awaiting-credential" }));
  const warnings = steps.length < 2 ? ["Configure at least two specialist profiles to create a multi-agent handoff."] : ["This is a reviewable draft. Execution remains disabled until credentials and explicit approval are provided."];
  return { id: randomUUID(), objective, createdAt: Date.now(), sourceTabCount: Math.max(0, request.sourceTabCount), status: "draft", steps, warnings };
}
