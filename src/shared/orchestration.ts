import type { AgentRole } from "./agent.js";

export type OrchestrationStep = {
  id: string;
  agentId: string;
  role: AgentRole;
  title: string;
  dependsOn: string[];
  contextPolicy: "selected-tabs" | "artifact-only" | "repository-only";
  state: "planned" | "awaiting-credential" | "ready";
};

export type OrchestrationPlan = {
  id: string;
  objective: string;
  createdAt: number;
  sourceTabCount: number;
  status: "draft" | "ready-for-approval";
  steps: OrchestrationStep[];
  warnings: string[];
};

export type OrchestrationRequest = {
  objective: string;
  sourceTabCount: number;
  availableRoles: AgentRole[];
};
