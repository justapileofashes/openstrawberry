export type AgentRole = "companion" | "orchestrator" | "researcher" | "coder" | "reviewer";
export type AgentProfileSummary = { id: string; name: string; role: AgentRole; provider: string; credentialStatus: "not-configured" | "ready" | "revoked" };
export const defaultAgentProfiles: AgentProfileSummary[] = [
  { id: "companion", name: "Companion", role: "companion", provider: "Not configured", credentialStatus: "not-configured" },
  { id: "orchestrator", name: "Orchestrator", role: "orchestrator", provider: "Not configured", credentialStatus: "not-configured" },
  { id: "researcher", name: "Researcher", role: "researcher", provider: "Not configured", credentialStatus: "not-configured" },
  { id: "coder", name: "Coder", role: "coder", provider: "Local CLI not detected", credentialStatus: "not-configured" },
  { id: "reviewer", name: "Reviewer", role: "reviewer", provider: "Not configured", credentialStatus: "not-configured" }
];
