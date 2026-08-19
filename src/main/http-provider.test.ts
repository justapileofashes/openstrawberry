import { describe, expect, it, vi } from "vitest";
import { callProvider, type FetchPort } from "./http-provider.js";

const KEY = "sk-ant-PROVIDER-CANARY-1234567890abcdef";

/** A body the bounded reader can consume. */
function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

function fetchReturning(
  payload: unknown,
  status = 200,
  captured?: Captured[]
): FetchPort {
  return async (url, init) => {
    captured?.push({
      url,
      headers: init.headers,
      body: init.body,
      redirect: init.redirect
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: bodyOf(typeof payload === "string" ? payload : JSON.stringify(payload))
    };
  };
}

const ANTHROPIC_REPLY = { content: [{ type: "text", text: "Hello from the model." }] };
const OPENAI_REPLY = { choices: [{ message: { content: "Hello from the model." } }] };

describe("callProvider", () => {
  it("calls Anthropic and returns its text", async () => {
    const captured: Captured[] = [];
    const result = await callProvider({
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(ANTHROPIC_REPLY, 200, captured)
    });

    expect(result).toEqual({ ok: true, text: "Hello from the model." });
    expect(captured[0]?.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("calls an OpenAI-compatible provider and returns its text", async () => {
    const result = await callProvider({
      provider: "openai",
      model: "gpt-5",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(OPENAI_REPLY)
    });

    expect(result).toEqual({ ok: true, text: "Hello from the model." });
  });

  it("never follows a redirect", async () => {
    // The rule that matters most: a following client would hand the key to
    // whoever controls the redirect target.
    const captured: Captured[] = [];
    await callProvider({
      provider: "anthropic",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(ANTHROPIC_REPLY, 200, captured)
    });

    expect(captured[0]?.redirect).toBe("error");
  });

  it("sends the key in the provider's own header and nowhere else", async () => {
    const captured: Captured[] = [];
    await callProvider({
      provider: "anthropic",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(ANTHROPIC_REPLY, 200, captured)
    });

    expect(captured[0]?.headers["x-api-key"]).toBe(KEY);
    expect(captured[0]?.headers["authorization"]).toBeUndefined();
    // Never in the URL, where it would reach logs and history.
    expect(captured[0]?.url).not.toContain(KEY);
    expect(captured[0]?.body).not.toContain(KEY);
  });

  it("uses a bearer token for the OpenAI dialect", async () => {
    const captured: Captured[] = [];
    await callProvider({
      provider: "openrouter",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(OPENAI_REPLY, 200, captured)
    });

    expect(captured[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(captured[0]?.headers["x-api-key"]).toBeUndefined();
  });

  it("refuses to send without a credential the provider requires", async () => {
    const called = vi.fn();
    const result = await callProvider({
      provider: "anthropic",
      model: "m",
      baseUrl: null,
      credential: null,
      prompt: "hi",
      fetch: (async (...args) => {
        called(...args);
        return { ok: true, status: 200, body: bodyOf("{}") };
      }) as FetchPort
    });

    expect(result).toEqual({ ok: false, code: "no-credential" });
    // And nothing was sent at all.
    expect(called).not.toHaveBeenCalled();
  });

  it("allows a local runtime with no credential", async () => {
    const result = await callProvider({
      provider: "ollama",
      model: "llama3.1",
      baseUrl: null,
      credential: null,
      prompt: "hi",
      fetch: fetchReturning({ message: { content: "local reply" } })
    });

    expect(result).toEqual({ ok: true, text: "local reply" });
  });

  it("refuses a provider it has no dialect for", async () => {
    const result = await callProvider({
      provider: "claude-code",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(OPENAI_REPLY)
    });

    expect(result).toEqual({ ok: false, code: "unsupported-provider" });
  });

  it("refuses a plaintext endpoint that is not loopback", async () => {
    // A key must not cross the network in the clear.
    const result = await callProvider({
      provider: "openai-compatible",
      model: "m",
      baseUrl: "http://api.example.com/v1",
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(OPENAI_REPLY)
    });

    expect(result).toEqual({ ok: false, code: "bad-endpoint" });
  });

  it("maps provider statuses onto codes the chrome has wording for", async () => {
    const cases: readonly [number, string][] = [
      [401, "unauthorised"],
      [403, "unauthorised"],
      [429, "rate-limited"],
      [500, "provider-error"]
    ];

    for (const [status, code] of cases) {
      const result = await callProvider({
        provider: "openai",
        model: "m",
        baseUrl: null,
        credential: KEY,
        prompt: "hi",
        fetch: fetchReturning({ error: { message: `contains ${KEY}` } }, status)
      });

      expect(result).toEqual({ ok: false, code });
    }
  });

  it("keeps the key out of the URL for every provider that has one", async () => {
    // One assertion over the whole set, so a dialect added later cannot quietly
    // adopt the query-parameter form.
    for (const provider of ["anthropic", "openai", "openrouter", "google"] as const) {
      const captured: Captured[] = [];
      await callProvider({
        provider,
        model: "some-model",
        baseUrl: null,
        credential: KEY,
        prompt: "hi",
        fetch: fetchReturning({ nothing: true }, 200, captured)
      });

      expect(captured[0]?.url, provider).not.toContain(KEY);
      expect(captured[0]?.body, provider).not.toContain(KEY);
    }
  });

  it("never returns anything derived from the provider's error body", async () => {
    // A gateway echoing the request back must not put the key into a run log.
    const result = await callProvider({
      provider: "openai",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning({ error: { message: `your key ${KEY} is invalid` } }, 401)
    });

    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("PROVIDER-CANARY");
  });

  it("reports a network failure without inspecting it", async () => {
    const result = await callProvider({
      provider: "openai",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED while sending ${KEY}`);
      }
    });

    expect(result).toEqual({ ok: false, code: "network" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("reports a cancelled run as cancelled, not as a failure", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await callProvider({
      provider: "openai",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      signal: controller.signal,
      fetch: async () => {
        throw new Error("aborted");
      }
    });

    expect(result).toEqual({ ok: false, code: "cancelled" });
  });

  it("reports an unreadable reply rather than an empty success", async () => {
    for (const payload of ["not json", "{}", JSON.stringify({ choices: [] }), ""]) {
      const result = await callProvider({
        provider: "openai",
        model: "m",
        baseUrl: null,
        credential: KEY,
        prompt: "hi",
        fetch: fetchReturning(payload)
      });

      expect(result.ok).toBe(false);
    }
  });

  it("abandons a reply larger than the cap", async () => {
    const endless: FetchPort = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(64 * 1024));
        }
      })
    });

    const result = await callProvider({
      provider: "openai",
      model: "m",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: endless
    });

    expect(result).toEqual({ ok: false, code: "too-large" });
  });

  it("honours a user-supplied https endpoint", async () => {
    const captured: Captured[] = [];
    await callProvider({
      provider: "openai-compatible",
      model: "m",
      baseUrl: "https://gateway.example.com/v1",
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(OPENAI_REPLY, 200, captured)
    });

    expect(captured[0]?.url).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("calls Google and returns its text", async () => {
    const captured: Captured[] = [];
    const result = await callProvider({
      provider: "google",
      model: "gemini-2.5-pro",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(
        { candidates: [{ content: { parts: [{ text: "Hello from Gemini." }] } }] },
        200,
        captured
      )
    });

    expect(result).toEqual({ ok: true, text: "Hello from Gemini." });
    expect(captured[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
    );
  });

  it("sends Google's key in a header, never in the query string", async () => {
    // Google's API accepts ?key=, and that form is refused: a credential in a
    // URL reaches server logs, proxy logs, and every intermediary that records
    // a request line.
    const captured: Captured[] = [];
    await callProvider({
      provider: "google",
      model: "gemini-2.5-pro",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(
        { candidates: [{ content: { parts: [{ text: "x" }] } }] },
        200,
        captured
      )
    });

    expect(captured[0]?.headers["x-goog-api-key"]).toBe(KEY);
    expect(captured[0]?.url).not.toContain(KEY);
    expect(captured[0]?.url).not.toContain("key=");
  });

  it("refuses a Google model name that would walk out of the path", async () => {
    // The model is user-typed and lands in a URL path, so a separator is
    // refused outright rather than encoded.
    for (const model of ["../../v1/other", "a/b", "..", "  "]) {
      const result = await callProvider({
        provider: "google",
        model,
        baseUrl: null,
        credential: KEY,
        prompt: "hi",
        fetch: fetchReturning({ candidates: [] })
      });

      expect(result, model).toEqual({ ok: false, code: "bad-endpoint" });
    }
  });

  it("percent-encodes a Google model name with awkward characters", async () => {
    const captured: Captured[] = [];
    await callProvider({
      provider: "google",
      model: "gemini pro?x=1",
      baseUrl: null,
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(
        { candidates: [{ content: { parts: [{ text: "x" }] } }] },
        200,
        captured
      )
    });

    // The query separator cannot survive into the URL as syntax.
    expect(captured[0]?.url).toContain("gemini%20pro%3Fx%3D1");
  });

  it("does not double the path when the base already names it", async () => {
    const captured: Captured[] = [];
    await callProvider({
      provider: "openai-compatible",
      model: "m",
      baseUrl: "https://gateway.example.com/v1/chat/completions",
      credential: KEY,
      prompt: "hi",
      fetch: fetchReturning(OPENAI_REPLY, 200, captured)
    });

    expect(captured[0]?.url).toBe("https://gateway.example.com/v1/chat/completions");
  });
});
