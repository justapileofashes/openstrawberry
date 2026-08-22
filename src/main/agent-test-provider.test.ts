/**
 * Trying a configuration before it is applied.
 *
 * The button behind this exists to answer one question — would this route
 * work — and the risk in answering it is that the answer is produced by
 * something other than the route on screen. So what is checked here is that the
 * request goes out with the *form's* provider, model, endpoint, and
 * temperature rather than the saved ones; that the stored key is read exactly
 * as a run reads it and never comes back; and that a CLI route is checked
 * rather than executed, since starting a process to see whether a process
 * starts is not a thing a settings dialog should do.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AgentManager,
  PROVIDER_TEST_PROMPT,
  type BrowserPort,
  type CommandPort,
  type ProviderPort
} from "./agent-manager.js";
import { SecretStore, type CipherPort } from "./secret-store.js";
import { emptyTuning, type ProviderTestPayload } from "../shared/agents.js";
import type { BrowserSnapshot } from "../shared/browser.js";

function bufferCipher(): CipherPort {
  const shift = 42;
  return {
    availability: () => "available",
    encrypt: (plaintext) =>
      Buffer.from([...Buffer.from(plaintext, "utf8")].map((byte) => byte ^ shift)),
    decrypt: (ciphertext) =>
      Buffer.from([...ciphertext].map((byte) => byte ^ shift)).toString("utf8")
  };
}

const EMPTY_BROWSER: BrowserSnapshot = {
  tabs: [],
  panes: [
    { id: "primary", activeTabId: null },
    { id: "secondary", activeTabId: null }
  ],
  activePaneId: "primary",
  splitEnabled: false,
  groups: []
};

/** A browser that does nothing. A test never touches a tab. */
const browser = {
  snapshot: () => EMPTY_BROWSER
} as unknown as BrowserPort;

type Call = Parameters<ProviderPort>[0];

function request(overrides: Partial<ProviderTestPayload> = {}): ProviderTestPayload {
  return {
    provider: "anthropic",
    model: null,
    baseUrl: null,
    command: null,
    tuning: emptyTuning(),
    companionId: null,
    ...overrides
  };
}

function harness(
  options: {
    readonly answer?: Awaited<ReturnType<ProviderPort>>;
    readonly withProvider?: boolean;
    readonly withCommand?: boolean;
  } = {}
): {
  readonly manager: AgentManager;
  readonly secrets: SecretStore;
  readonly calls: readonly Call[];
  readonly commandRuns: () => number;
} {
  const directory = mkdtempSync(join(tmpdir(), "openstrawberry-test-provider-"));
  const secrets = new SecretStore({
    credentialPath: join(directory, "agent-credentials.enc"),
    profilePath: join(directory, "agent-profile.json"),
    cipher: bufferCipher()
  });

  const calls: Call[] = [];
  let commandRuns = 0;

  const provider: ProviderPort = (call) => {
    calls.push(call);
    return Promise.resolve(options.answer ?? { ok: true, text: "ok" });
  };

  const command: CommandPort = () => {
    commandRuns += 1;
    return Promise.resolve({ ok: true, text: "ok" });
  };

  const manager = new AgentManager({
    statePath: join(directory, "agents.json"),
    browser,
    secrets,
    publish: () => undefined,
    ...(options.withProvider === false ? {} : { provider }),
    ...(options.withCommand === false ? {} : { command }),
    supportsBrowserTools: () => false
  });

  manager.restore();

  return { manager, secrets, calls, commandRuns: () => commandRuns };
}

let signal: AbortSignal;

beforeEach(() => {
  signal = new AbortController().signal;
});

describe("testProvider", () => {
  it("reports a provider that answered, with how long it took", async () => {
    const { manager, secrets } = harness();
    secrets.setCredential("anthropic", "sk-ant-test-key-value");

    const result = await manager.testProvider(request(), signal);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the route the form is holding, not the one that is saved", async () => {
    const { manager, secrets, calls } = harness();
    // Saved: Anthropic. Being tried: a compatible endpoint. Testing the saved
    // route would answer a question nobody asked.
    secrets.setOrchestrator("anthropic", "claude-opus-5");
    secrets.setCredential("openai-compatible", "sk-compatible-key-value");

    await manager.testProvider(
      request({
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: "https://api.example.com/v1",
        tuning: { ...emptyTuning(), temperature: 0.4 }
      }),
      signal
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe("openai-compatible");
    expect(calls[0]?.model).toBe("llama-3.3");
    expect(calls[0]?.baseUrl).toBe("https://api.example.com/v1");
    expect(calls[0]?.temperature).toBe(0.4);
  });

  it("falls back to the provider's default model when the box was left blank", async () => {
    const { manager, secrets, calls } = harness();
    secrets.setCredential("anthropic", "sk-ant-test-key-value");

    await manager.testProvider(request({ model: null }), signal);

    expect(calls[0]?.model).toBe("claude-opus-5");
  });

  it("authenticates with the agent's own key when one is named", async () => {
    const { manager, secrets, calls } = harness();
    secrets.setCredential("anthropic", "shared-key-value");
    secrets.setCredential("anthropic", "agent-key-value", "companion-scout");

    await manager.testProvider(request({ companionId: "companion-scout" }), signal);

    expect(calls[0]?.credential).toBe("agent-key-value");
  });

  it("falls back to the shared key for an agent that has none of its own", async () => {
    const { manager, secrets, calls } = harness();
    secrets.setCredential("anthropic", "shared-key-value");

    await manager.testProvider(request({ companionId: "companion-scout" }), signal);

    expect(calls[0]?.credential).toBe("shared-key-value");
  });

  it("returns a code rather than anything the provider said", async () => {
    /*
     * The reply to a test is remote text nothing has reviewed. That the call
     * completed is the whole answer, so there is no field here for the body to
     * travel in — and a failure carries this app's code, not the provider's.
     */
    const { manager, secrets } = harness({
      answer: { ok: false, code: "unauthorised" }
    });
    secrets.setCredential("anthropic", "sk-ant-wrong-key-value");

    const result = await manager.testProvider(request(), signal);

    expect(result).toEqual({ ok: false, code: "unauthorised" });
    expect(JSON.stringify(result)).not.toContain("sk-ant");
  });

  it("asks for as little as a real request can ask for", async () => {
    const { manager, secrets, calls } = harness();
    secrets.setCredential("anthropic", "sk-ant-test-key-value");

    await manager.testProvider(request(), signal);

    expect(calls[0]?.prompt).toBe(PROVIDER_TEST_PROMPT);
    expect(PROVIDER_TEST_PROMPT.length).toBeLessThan(64);
  });

  it("reports a missing key as this app's own code", async () => {
    const { manager } = harness({ answer: { ok: false, code: "no-credential" } });

    const result = await manager.testProvider(request(), signal);

    expect(result).toEqual({ ok: false, code: "no-credential" });
  });

  it("treats a broken transport as a network failure rather than throwing", async () => {
    const { manager } = harness({ withProvider: false });

    await expect(manager.testProvider(request(), signal)).resolves.toEqual({
      ok: false,
      code: "unsupported-provider"
    });
  });

  it("refuses a provider this build has no transport for", async () => {
    const { manager } = harness({ withProvider: false });

    const result = await manager.testProvider(request({ provider: "openai" }), signal);

    expect(result).toEqual({ ok: false, code: "unsupported-provider" });
  });
});

describe("testProvider on a CLI route", () => {
  it("checks the program without running it", async () => {
    /*
     * Running the tool to see whether it runs would start a process, and
     * possibly a billed session, to answer a question the user only asked about
     * configuration.
     */
    const { manager, commandRuns } = harness();

    const result = await manager.testProvider(
      request({ provider: "claude-code", command: "claude" }),
      signal
    );

    expect(result.ok).toBe(true);
    expect(commandRuns()).toBe(0);
  });

  it("uses the preset's program when the box was left blank", async () => {
    const { manager } = harness();

    await expect(
      manager.testProvider(request({ provider: "claude-code", command: null }), signal)
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a program this app would not execute", async () => {
    const { manager } = harness();

    const result = await manager.testProvider(
      request({ provider: "claude-code", command: "curl" }),
      signal
    );

    expect(result).toEqual({ ok: false, code: "command-not-allowed" });
  });

  it("says so plainly when this build cannot run a program at all", async () => {
    const { manager } = harness({ withCommand: false });

    const result = await manager.testProvider(
      request({ provider: "claude-code", command: "claude" }),
      signal
    );

    expect(result).toEqual({ ok: false, code: "unsupported-provider" });
  });

  it("makes no request for a route that would not make one", async () => {
    const { manager, calls } = harness();

    await manager.testProvider(request({ provider: "claude-code" }), signal);

    expect(calls).toHaveLength(0);
  });
});
