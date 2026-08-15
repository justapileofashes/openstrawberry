export type AgentRunRequest = {
  agentId: string;
  prompt: string;
  context: { selectedTabUrls: string[]; artifactText?: string };
};

export type AgentRunResult = {
  agentId: string;
  provider: string;
  model: string;
  text: string;
  startedAt: number;
  completedAt: number;
  status: "completed" | "failed";
  error?: string;
};
