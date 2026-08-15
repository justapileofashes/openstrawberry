export type AgentRole = "companion" | "orchestrator" | "researcher" | "coder" | "reviewer";
export type CredentialStatus = "not-configured" | "ready" | "unavailable";
export type AgentProfileSummary = { id: string; name: string; role: AgentRole; provider: string; model: string; baseUrl: string; credentialStatus: CredentialStatus; executor: "provider" | "local-cli" };
export type AgentProfileInput = { id?: string; name: string; role: AgentRole; provider: string; model: string; baseUrl?: string; executor: "provider" | "local-cli"; apiKey?: string; clearCredential?: boolean };
export type LocalCliStatus = { command: string; label: string; available: boolean; path?: string };

export const defaultAgentProfiles: AgentProfileSummary[] = [
  { id: "companion", name: "Companion", role: "companion", provider: "Not configured", model: "Select a provider", baseUrl: "", credentialStatus: "not-configured", executor: "provider" },
  { id: "orchestrator", name: "Orchestrator", role: "orchestrator", provider: "Not configured", model: "Select a provider", baseUrl: "", credentialStatus: "not-configured", executor: "provider" },
  { id: "researcher", name: "Researcher", role: "researcher", provider: "Not configured", model: "Select a provider", baseUrl: "", credentialStatus: "not-configured", executor: "provider" },
  { id: "coder", name: "Coder", role: "coder", provider: "No local executor selected", model: "Select a CLI or provider", baseUrl: "", credentialStatus: "not-configured", executor: "local-cli" },
  { id: "reviewer", name: "Reviewer", role: "reviewer", provider: "Not configured", model: "Select a provider", baseUrl: "", credentialStatus: "not-configured", executor: "provider" }
];
