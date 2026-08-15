import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderRunner } from "./provider-runner.js";

const request = {
  agentId: "researcher-1",
  prompt: "Summarize the selected source.",
  context: { selectedTabUrls: ["https://example.com/path?token=never-send#fragment"] },
};

function providerRegistry() {
  return {
    resolveProviderCredential: vi.fn(() => ({
      profile: { id: "researcher-1", name: "Researcher", role: "researcher", provider: "openai", model: "gpt-test", baseUrl: "", executor: "provider", credentialStatus: "ready" },
      apiKey: "secret-provider-key",
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ProviderRunner", () => {
  it("uses the main-process credential, minimizes URL context, and returns a bounded success result", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      expect(init.headers).toMatchObject({ authorization: "Bearer secret-provider-key" });
      expect(body.messages[1]?.content).toContain("https://example.com");
      expect(body.messages[1]?.content).not.toContain("token=never-send");
      return new Response(JSON.stringify({ choices: [{ message: { content: "A safe handoff." } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ProviderRunner(providerRegistry() as never).run(request);

    expect(result).toMatchObject({ status: "completed", text: "A safe handoff.", agentId: "researcher-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts a credential echoed by an untrusted provider error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Rejected secret-provider-key" } }), { status: 401 })));

    const result = await new ProviderRunner(providerRegistry() as never).run(request);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("[redacted credential]");
    expect(result.error).not.toContain("secret-provider-key");
    expect(result.provider).toBe("redacted");
  });
});
