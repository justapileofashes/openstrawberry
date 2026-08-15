import { describe, expect, it } from "vitest";
import { createOrchestrationPlan } from "./orchestrator.js";

describe("createOrchestrationPlan", () => {
  it("creates a sequential specialist handoff with bounded context", () => {
    const plan = createOrchestrationPlan({ objective: "Review the selected tabs", sourceTabCount: 3, availableRoles: ["researcher", "coder", "reviewer"] });

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]).toMatchObject({ role: "researcher", dependsOn: [], contextPolicy: "selected-tabs" });
    expect(plan.steps[1]).toMatchObject({ role: "coder", dependsOn: ["researcher-1"], contextPolicy: "artifact-only" });
    expect(plan.steps[2]).toMatchObject({ role: "reviewer", dependsOn: ["coder-2"], contextPolicy: "artifact-only" });
    expect(plan.status).toBe("draft");
  });

  it("warns when there are not enough configured specialists", () => {
    const plan = createOrchestrationPlan({ objective: "Inspect a tab", sourceTabCount: 1, availableRoles: ["researcher"] });

    expect(plan.steps).toHaveLength(1);
    expect(plan.warnings[0]).toContain("at least two specialist profiles");
  });
});
