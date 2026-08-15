/* Provider runner: all credentials remain in the main process and every call is bounded to an explicit user-started task. */
import type { AgentRegistry } from "./agent-registry.js";
import type { AgentRunRequest, AgentRunResult } from "../shared/agent-run.js";
import { buildContextualPrompt, resolveProviderBaseUrl, resolveProviderProtocol } from "../shared/provider-protocol.js";

const RUN_TIMEOUT_MS = 90_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const MAX_ERROR_MESSAGE_LENGTH = 1_200;

export function redactProviderError(message: string, credential: string | undefined): string {
  const credentialPattern = credential ? credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const redacted = credentialPattern ? message.replace(new RegExp(credentialPattern, "g"), "[redacted credential]") : message;
  return redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export class ProviderRunner {
  public constructor(private readonly registry: AgentRegistry) {}

  public async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    let credential: string | undefined;
    try {
      const { profile, apiKey } = this.registry.resolveProviderCredential(request.agentId);
      credential = apiKey;
      const baseUrl = resolveProviderBaseUrl(profile);
      const prompt = buildContextualPrompt(request.prompt, request.context.selectedTabUrls, request.context.artifactText);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
      try {
        const protocol = resolveProviderProtocol(profile);
        const response = protocol === "anthropic-messages"
          ? await fetch(`${baseUrl}/v1/messages`, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: profile.model, max_tokens: 2048, system: `You are OpenStrawberry's ${profile.role}. Return a concise, verifiable handoff for the next agent.`, messages: [{ role: "user", content: prompt }] }) })
          : await fetch(`${baseUrl}/chat/completions`, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: profile.model, max_tokens: 2048, messages: [{ role: "system", content: `You are OpenStrawberry's ${profile.role}. Return a concise, verifiable handoff for the next agent.` }, { role: "user", content: prompt }] }) });
        const payload = JSON.parse(await this.readBoundedResponse(response)) as Record<string, unknown>;
        if (!response.ok) throw new Error(typeof payload.error === "object" && payload.error && "message" in payload.error ? String((payload.error as { message: unknown }).message) : `Provider request failed with status ${response.status}.`);
        const text = protocol === "anthropic-messages"
          ? Array.isArray(payload.content) ? payload.content.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && "type" in block && (block as { type: unknown }).type === "text" && "text" in block && typeof (block as { text: unknown }).text === "string").map((block) => block.text).join("\n") : ""
          : Array.isArray(payload.choices) ? String((((payload.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content) ?? "")) : "";
        if (!text.trim()) throw new Error("The provider returned no text response.");
        return { agentId: profile.id, provider: profile.provider, model: profile.model, text, startedAt, completedAt: Date.now(), status: "completed" };
      } finally { clearTimeout(timeout); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider run failed.";
      return { agentId: request.agentId, provider: "redacted", model: "redacted", text: "", startedAt, completedAt: Date.now(), status: "failed", error: redactProviderError(message, credential) };
    }
  }

  private async readBoundedResponse(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider response exceeded the 1 MB safety limit.");
    if (!response.body) return "{}";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PROVIDER_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Provider response exceeded the 1 MB safety limit."); }
        chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    } finally { reader.releaseLock(); }
  }
}
