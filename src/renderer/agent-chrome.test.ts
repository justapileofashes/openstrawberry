import { describe, expect, it } from "vitest";
import { BLANK_PAGE } from "../shared/desktop-shell.js";
import { emptyConfigStatus, emptyTuning } from "../shared/agents.js";
import type {
  AgentConfigStatus,
  AgentRunState,
  AgentSkillSummary,
  AgentSnapshot
} from "../shared/agents.js";
import type { BrowserSnapshot } from "../shared/browser.js";
import {
  canSaveCredential,
  canSubmitTask,
  configState,
  configSummary,
  defaultContextTabIds,
  encryptionNotice,
  providerLabel,
  formatStepTime,
  isRunAdvancing,
  isRunFinished,
  statusLabel,
  stepTone,
  suggestionsForRole,
  toggleContextTab,
  visibleRun
} from "./agent-chrome.js";

function run(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    id: "run-1",
    companionId: "companion-scout",
    task: "Summarize the open tabs",
    status: "done",
    steps: [],
    pendingApproval: null,
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...overrides
  };
}

function configStatus(overrides: Partial<AgentConfigStatus> = {}): AgentConfigStatus {
  return { ...emptyConfigStatus(), ...overrides };
}

function agentSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    companions: [
      {
        id: "companion-scout",
        name: "Scout",
        role: "research",
        skillPaths: [],
        provider: null,
        model: null,
        baseUrl: null,
        command: null,
        tuning: emptyTuning()
      }
    ],
    activeCompanionId: null,
    runs: [],
    activeRunId: null,
    config: configStatus(),
    ...overrides
  };
}

function browserSnapshot(): BrowserSnapshot {
  return {
    tabs: [
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "Example",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        isAudible: false,
        paneId: "primary",
        groupId: null
      },
      {
        id: "tab-2",
        url: BLANK_PAGE,
        title: "New tab",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        isAudible: false,
        paneId: "primary",
        groupId: null
      },
      {
        id: "tab-3",
        url: "https://other.example/",
        title: "Other",
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        isAudible: false,
        paneId: "secondary",
        groupId: null
      }
    ],
    panes: [
      { id: "primary", activeTabId: "tab-2" },
      { id: "secondary", activeTabId: "tab-3" }
    ],
    activePaneId: "secondary",
    splitEnabled: true,
    groups: []
  };
}

describe("visibleRun", () => {
  it("prefers the active run", () => {
    const snapshot = agentSnapshot({
      runs: [run({ id: "run-1" }), run({ id: "run-2" })],
      activeRunId: "run-1"
    });

    expect(visibleRun(snapshot)?.id).toBe("run-1");
  });

  it("falls back to the most recent run when the active id is stale", () => {
    const snapshot = agentSnapshot({
      runs: [run({ id: "run-1" }), run({ id: "run-2" })],
      activeRunId: "run-gone"
    });

    expect(visibleRun(snapshot)?.id).toBe("run-2");
  });

  it("reports nothing before the first run", () => {
    expect(visibleRun(agentSnapshot())).toBeNull();
  });
});

describe("statusLabel", () => {
  it("distinguishes a question being asked now from one that survived a restart", () => {
    expect(statusLabel("awaiting-approval")).toBe("Needs your approval");
    expect(statusLabel("paused")).toBe("Paused");
  });

  it("reads Ready before any run exists", () => {
    expect(statusLabel(null)).toBe("Ready");
    expect(statusLabel("idle")).toBe("Ready");
  });
});

describe("isRunAdvancing", () => {
  it("is true only while the loop is moving on its own", () => {
    expect(isRunAdvancing("planning")).toBe(true);
    expect(isRunAdvancing("acting")).toBe(true);
  });

  it("is false while the run is waiting on the user", () => {
    // A gated run must not look busy — the user is the one holding it up.
    expect(isRunAdvancing("awaiting-approval")).toBe(false);
    expect(isRunAdvancing("paused")).toBe(false);
    expect(isRunAdvancing(null)).toBe(false);
  });
});

describe("isRunFinished", () => {
  it("covers every terminal status", () => {
    expect(isRunFinished("done")).toBe(true);
    expect(isRunFinished("failed")).toBe(true);
    expect(isRunFinished("cancelled")).toBe(true);
    expect(isRunFinished("acting")).toBe(false);
    expect(isRunFinished(null)).toBe(false);
  });
});

describe("stepTone", () => {
  it("marks only an error as bad, so colour keeps meaning", () => {
    expect(stepTone("error")).toBe("bad");
    expect(stepTone("message")).toBe("neutral");
    expect(stepTone("thought")).toBe("quiet");
    expect(stepTone("tool-call")).toBe("quiet");
    expect(stepTone("tool-result")).toBe("quiet");
  });
});

describe("formatStepTime", () => {
  it("zero-pads so the log stays column-aligned", () => {
    // Built from local parts so the assertion does not depend on the test
    // machine's time zone.
    const at = new Date(2024, 0, 1, 9, 5).getTime();

    expect(formatStepTime(at)).toBe("09:05");
  });
});

describe("defaultContextTabIds", () => {
  it("offers the focused tab only, never every open tab", () => {
    // Defaulting to all tabs would make "the agent sees what I chose" false on
    // the first run, before the user has chosen anything.
    expect(defaultContextTabIds(browserSnapshot())).toEqual(["tab-3"]);
  });
});

describe("toggleContextTab", () => {
  it("adds a tab and keeps selection in snapshot order", () => {
    const snapshot = browserSnapshot();
    const selected = toggleContextTab(["tab-3"], "tab-1", snapshot);

    expect(selected).toEqual(["tab-1", "tab-3"]);
  });

  it("removes a tab that was already selected", () => {
    const snapshot = browserSnapshot();

    expect(toggleContextTab(["tab-1", "tab-3"], "tab-1", snapshot)).toEqual(["tab-3"]);
  });

  it("drops a selected tab that has since been closed", () => {
    const snapshot = browserSnapshot();

    expect(toggleContextTab(["tab-1", "tab-gone"], "tab-2", snapshot)).toEqual([
      "tab-1",
      "tab-2"
    ]);
  });
});

describe("canSubmitTask", () => {
  it("refuses whitespace, which would start a run with no instruction", () => {
    expect(canSubmitTask("   ", null)).toBe(false);
    expect(canSubmitTask("", null)).toBe(false);
  });

  it("refuses while a run is already advancing", () => {
    expect(canSubmitTask("do the thing", "acting")).toBe(false);
  });

  it("allows a new task once the run is waiting or finished", () => {
    expect(canSubmitTask("do the thing", "done")).toBe(true);
    expect(canSubmitTask("do the thing", "paused")).toBe(true);
    expect(canSubmitTask("do the thing", null)).toBe(true);
  });
});

describe("configState", () => {
  function config(overrides: Partial<AgentConfigStatus> = {}): AgentConfigStatus {
    return configStatus({ encryption: "available", ...overrides });
  }

  it("reports unavailable even when a key is somehow already stored", () => {
    // Refusing to store outranks everything else: offering an input here would
    // invite the user to type a secret into a field guaranteed to reject it.
    expect(configState(config({ configured: true, encryption: "unavailable" }))).toBe(
      "unavailable"
    );
  });

  it("treats a missing keyring as unavailable too, not as merely disconnected", () => {
    // The key would be refused just the same, so the connect form must not be
    // offered — only the reason the user reads differs.
    expect(configState(config({ encryption: "no-keyring" }))).toBe("unavailable");
  });

  it("distinguishes connected from disconnected", () => {
    expect(configState(config({ configured: true }))).toBe("connected");
    expect(configState(config({ configured: false }))).toBe("disconnected");
  });
});

describe("encryptionNotice", () => {
  function config(encryption: AgentConfigStatus["encryption"]): AgentConfigStatus {
    return configStatus({ encryption });
  }

  it("says nothing when a key can actually be stored", () => {
    expect(encryptionNotice(config("available"))).toBeNull();
  });

  it("names the fix when the problem is a missing keyring", () => {
    const notice = encryptionNotice(config("no-keyring"));

    // The distinction that earns this state its own value: a user who can fix
    // this needs to be told what to fix, not that their system is incapable.
    expect(notice).toContain("keyring");
    expect(notice).not.toContain("no OS-level encryption");
  });

  it("does not promise a fix when the system simply cannot encrypt", () => {
    expect(encryptionNotice(config("unavailable"))).toContain("no OS-level encryption");
  });

  it("never suggests a key was stored anyway", () => {
    for (const state of ["no-keyring", "unavailable"] as const) {
      expect(encryptionNotice(config(state))).toContain("will not store");
    }
  });
});

describe("providerLabel", () => {
  it("uses a shipped provider's own name", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
  });

  it("does not title-case a name that carries its own casing", () => {
    // "Openai" is not what the company is called, and a display name is a name
    // rather than a transformation of an id.
    expect(providerLabel("openai")).toBe("OpenAI");
  });

  it("falls back to title case for anything it does not ship", () => {
    expect(providerLabel("someprovider")).toBe("Someprovider");
  });

  it("does not crash on an empty provider", () => {
    expect(providerLabel("")).toBe("Unknown");
  });
});

describe("configSummary", () => {
  it("names the provider and model without implying anything about the key", () => {
    expect(
      configSummary(
        configStatus({ configured: true, encryption: "available" })
      )
    ).toBe("Anthropic · claude-opus-5");
  });
});

describe("canSaveCredential", () => {
  const available = configStatus({ encryption: "available" });

  it("refuses whitespace", () => {
    expect(canSaveCredential("   ", available)).toBe(false);
  });

  it("refuses whenever the store would, for either reason", () => {
    for (const encryption of ["unavailable", "no-keyring"] as const) {
      expect(canSaveCredential("sk-test", { ...available, encryption })).toBe(false);
    }
  });

  it("allows a real key", () => {
    expect(canSaveCredential("sk-test", available)).toBe(true);
  });
});

describe("suggestionsForRole", () => {
  function skill(path: string, tags: readonly string[]): AgentSkillSummary {
    return {
      path,
      name: path,
      description: "A skill",
      displayName: path,
      tags
    };
  }

  it("ranks skills tagged for the role first", () => {
    const skills = [
      skill("sales/find-new-customers", ["sales"]),
      skill("research-analysis/map-a-market", ["research"])
    ];

    expect(suggestionsForRole(skills, "research").map((entry) => entry.path)).toEqual([
      "research-analysis/map-a-market",
      "sales/find-new-customers"
    ]);
  });

  it("caps how many chips it will offer", () => {
    const skills = Array.from({ length: 10 }, (_, index) =>
      skill(`collection/skill-${index}`, [])
    );

    expect(suggestionsForRole(skills, "research")).toHaveLength(4);
  });
});
