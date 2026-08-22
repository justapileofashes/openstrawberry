/**
 * Handing a run the browser, and stopping it for the user.
 *
 * Two things are proved here. The first is that a session is opened only for a
 * run on a route that can use one, and is closed again whatever the run did.
 * The second is the gate: `pendingApproval` and `resolveApproval` were built
 * before anything produced a request, and this is the suite that holds the
 * producer to the contract the consumer already assumes.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentManager,
  APPROVAL_TIMEOUT_MS,
  type BrowserPort,
  type BrowserSessionPort,
  type CommandPort
} from "./agent-manager.js";
import { SecretStore, type CipherPort } from "./secret-store.js";
import {
  activeRun,
  emptyTuning,
  parseStartRunPayload,
  type AgentSnapshot
} from "../shared/agents.js";
import { BROWSER_TOOL_BRIEFING } from "../shared/browser-tools.js";
import type { BrowserSnapshot, BrowserTabState } from "../shared/browser.js";
import type { ChatMessage, ChatOutcome, ToolCall } from "../shared/provider-request.js";

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

function tabState(id: string, url: string, title: string): BrowserTabState {
  return {
    id,
    url,
    title,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    isAudible: false,
    paneId: "primary",
    groupId: null
  };
}

/** Mutable, because the in-process loop actually drives this. */
let tabs: BrowserTabState[] = [];
let browserActions: string[] = [];

function snapshotOf(): BrowserSnapshot {
  return {
    tabs,
    panes: [
      { id: "primary", activeTabId: tabs[0]?.id ?? null },
      { id: "secondary", activeTabId: null }
    ],
    activePaneId: "primary",
    splitEnabled: false,
    groups: []
  };
}

const READABLE_PAGE = {
  title: "The Kelp Forests",
  byline: "",
  site: "example.com",
  blocks: [
    {
      kind: "paragraph",
      text: "Giant kelp grows up to sixty centimetres a day, which makes it one of the fastest growing organisms anywhere."
    }
  ]
};

const browser: BrowserPort = {
  snapshot: snapshotOf,
  createTab: (paneId, url) => {
    browserActions.push(`createTab ${paneId} ${url}`);
    tabs = [...tabs, tabState("tab-9", url, url)];
    return snapshotOf();
  },
  closeTab: (tabId) => {
    browserActions.push(`closeTab ${tabId}`);
    tabs = tabs.filter((entry) => entry.id !== tabId);
    return snapshotOf();
  },
  navigate: (tabId, address) => {
    browserActions.push(`navigate ${tabId} ${address}`);
    tabs = tabs.map((entry) => (entry.id === tabId ? { ...entry, url: address } : entry));
    return snapshotOf();
  },
  goBack: (tabId) => {
    browserActions.push(`goBack ${tabId}`);
    return snapshotOf();
  },
  goForward: (tabId) => {
    browserActions.push(`goForward ${tabId}`);
    return snapshotOf();
  },
  reload: (tabId) => {
    browserActions.push(`reload ${tabId}`);
    return snapshotOf();
  },
  contentsFor: (tabId) =>
    tabs.some((entry) => entry.id === tabId)
      ? ({
          getURL: () => tabs.find((entry) => entry.id === tabId)?.url ?? "",
          executeJavaScript: () => Promise.resolve(READABLE_PAGE)
        } as unknown as Electron.WebContents)
      : null
};

type Approve = (
  toolName: string,
  summary: string,
  reason: string,
  tabId: string | null
) => Promise<boolean>;

interface Harness {
  readonly manager: AgentManager;
  readonly snapshot: () => AgentSnapshot;
  /** Resolves once the command port has been entered, with the session's gate. */
  readonly started: Promise<{ approve: Approve | null; mcpConfigPath: string | null }>;
  readonly finish: () => void;
  readonly sessionOpens: () => number;
  readonly sessionCloses: () => number;
  readonly grantedTabIds: () => readonly string[];
  readonly agentName: () => string;
  readonly prompts: () => readonly string[];
}

let directory = "";

function build(
  options: {
    readonly withSessions?: boolean;
    readonly supports?: boolean;
    readonly sessionFails?: boolean;
  } = {}
): Harness {
  const secrets = new SecretStore({
    credentialPath: join(directory, "agent-credentials.enc"),
    profilePath: join(directory, "agent-profile.json"),
    cipher: bufferCipher()
  });

  let approve: Approve | null = null;
  let mcpConfigPath: string | null = null;
  let opens = 0;
  let closes = 0;
  let granted: readonly string[] = [];
  let agentName = "";
  const prompts: string[] = [];

  let announceStart: (value: {
    approve: Approve | null;
    mcpConfigPath: string | null;
  }) => void = () => undefined;
  const started = new Promise<{ approve: Approve | null; mcpConfigPath: string | null }>(
    (resolve) => {
      announceStart = resolve;
    }
  );

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const browserSessions: BrowserSessionPort = (request) => {
    opens += 1;
    if (options.sessionFails === true) return Promise.resolve(null);

    approve = request.approve;
    granted = request.tabIds;
    agentName = request.agentName;

    return Promise.resolve({
      configPath: "/data/openstrawberry/mcp-session-1.json",
      close: () => {
        closes += 1;
      }
    });
  };

  const command: CommandPort = async (request) => {
    prompts.push(request.prompt);
    mcpConfigPath = request.mcpConfigPath;
    announceStart({ approve, mcpConfigPath });
    await held;
    return { ok: true, text: "finished" };
  };

  const manager = new AgentManager({
    statePath: join(directory, "agents.json"),
    browser,
    secrets,
    publish: () => undefined,
    provider: () => Promise.resolve({ ok: false, code: "network" }),
    command,
    ...(options.withSessions === false ? {} : { browserSessions }),
    supportsBrowserTools: () => options.supports !== false
  });

  manager.restore();
  // A CLI orchestrator, so every route resolves to a program rather than an
  // endpoint. `claude-code` is the preset whose default command is `claude`.
  manager.setOrchestrator({
    provider: "claude-code",
    model: "",
    baseUrl: null,
    command: "claude",
    tuning: emptyTuning()
  });

  return {
    manager,
    snapshot: () => manager.snapshot(),
    started,
    finish: () => release(),
    sessionOpens: () => opens,
    sessionCloses: () => closes,
    grantedTabIds: () => granted,
    agentName: () => agentName,
    prompts: () => prompts
  };
}

function start(harness: Harness, tabIds: readonly string[] = ["tab-1"]): void {
  const companionId = harness.snapshot().companions[0]?.id ?? "";
  harness.manager.startRun(
    parseStartRunPayload({ companionId, task: "read the page", tabIds: [...tabIds] })
  );
}

function currentRun(harness: Harness): ReturnType<typeof activeRun> {
  return activeRun(harness.snapshot());
}

/**
 * Runs the scheduler forward.
 *
 * The run loop pauses between its scripted steps, and a gate arms a timer that
 * has to be reachable from a test without waiting three minutes for it. Fake
 * timers give both, and `advanceTimersByTimeAsync` flushes the microtasks in
 * between - which is what makes "the command port has been entered" and "the
 * finally block has run" observable rather than raced against.
 */
async function advance(ms = 2000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Runs until the tool has been started, and hands back its session's gate. */
async function enter(harness: Harness): Promise<{
  approve: Approve | null;
  mcpConfigPath: string | null;
}> {
  await advance();
  return harness.started;
}

beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-agent-browser-"));
  tabs = [
    tabState("tab-1", "https://example.com/kelp", "The Kelp Forests"),
    tabState("tab-2", "https://bank.example/statements", "Private Banking")
  ];
  browserActions = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opening a session", () => {
  it("hands the config to the tool and prepends the briefing", async () => {
    const harness = build();
    start(harness);

    const entered = await enter(harness);
    expect(entered.mcpConfigPath).toBe("/data/openstrawberry/mcp-session-1.json");
    expect(harness.prompts()[0]?.startsWith(BROWSER_TOOL_BRIEFING)).toBe(true);
    expect(harness.prompts()[0]).toContain("read the page");

    harness.finish();
    harness.manager.destroy();
  });

  it("grants exactly the tabs the user picked", async () => {
    const harness = build();
    start(harness, ["tab-1"]);
    await enter(harness);

    expect(harness.grantedTabIds()).toEqual(["tab-1"]);
    expect(harness.agentName()).toBe("Scout");

    harness.finish();
    harness.manager.destroy();
  });

  it("grants nothing when the user picked nothing", async () => {
    const harness = build();
    start(harness, []);
    await enter(harness);

    expect(harness.grantedTabIds()).toEqual([]);

    harness.finish();
    harness.manager.destroy();
  });

  it("opens none for a program with no checked invocation", async () => {
    const harness = build({ supports: false });
    start(harness);

    const entered = await enter(harness);
    expect(entered.mcpConfigPath).toBeNull();
    expect(harness.sessionOpens()).toBe(0);
    expect(harness.prompts()[0]).not.toContain(BROWSER_TOOL_BRIEFING);

    harness.finish();
    harness.manager.destroy();
  });

  it("opens none in a build with no transport for one", async () => {
    const harness = build({ withSessions: false });
    start(harness);

    const entered = await enter(harness);
    expect(entered.mcpConfigPath).toBeNull();

    harness.finish();
    harness.manager.destroy();
  });

  it("runs the tool anyway when a session could not be opened", async () => {
    // A coding CLI with no tools still answers the question it was asked.
    const harness = build({ sessionFails: true });
    start(harness);

    const entered = await enter(harness);
    expect(harness.sessionOpens()).toBe(1);
    expect(entered.mcpConfigPath).toBeNull();

    harness.finish();
    harness.manager.destroy();
  });

  it("closes the session once the tool has finished", async () => {
    const harness = build();
    start(harness);
    await enter(harness);

    expect(harness.sessionCloses()).toBe(0);
    harness.finish();

    await advance();
    expect(harness.sessionCloses()).toBe(1);
    harness.manager.destroy();
  });

  it("opens none for a plan step, which has no run to raise a gate on", async () => {
    const harness = build();
    void harness.manager.dispatch(
      harness.snapshot().companions[0]?.id ?? "",
      "a plan step",
      new AbortController().signal
    );

    const entered = await enter(harness);
    expect(entered.mcpConfigPath).toBeNull();
    expect(harness.sessionOpens()).toBe(0);

    harness.finish();
    harness.manager.destroy();
  });
});

describe("the gate", () => {
  it("parks the run and answers with what the user said", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    const decision = (approve as Approve)(
      "close_tab",
      "Scout wants to close a tab",
      "Changing what the browser is doing needs your say-so.",
      "tab-1"
    );

    expect(currentRun(harness)?.status).toBe("awaiting-approval");

    const request = currentRun(harness)?.pendingApproval;
    expect(request?.toolName).toBe("close_tab");
    expect(request?.summary).toContain("Scout");
    expect(request?.tabId).toBe("tab-1");

    harness.manager.resolveApproval({
      approvalId: request?.id ?? "",
      decision: "allow"
    });

    await expect(decision).resolves.toBe(true);
    expect(currentRun(harness)?.status).toBe("acting");
    expect(currentRun(harness)?.pendingApproval).toBeNull();

    harness.finish();
    harness.manager.destroy();
  });

  it("answers false when the user denies, and the run carries on", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    const decision = (approve as Approve)("navigate_tab", "Scout wants to navigate", "why", "tab-1");

    harness.manager.resolveApproval({
      approvalId: currentRun(harness)?.pendingApproval?.id ?? "",
      decision: "deny"
    });

    // A denial is not a failure: the run resumes so the agent can pick another
    // route rather than dying on a "no".
    await expect(decision).resolves.toBe(false);
    expect(currentRun(harness)?.status).toBe("acting");

    harness.finish();
    harness.manager.destroy();
  });

  it("writes the request into the run log before anyone answers", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    void (approve as Approve)("close_tab", "Scout wants to close a tab", "why", "tab-1");

    const step = currentRun(harness)?.steps.at(-1);
    expect(step?.kind).toBe("tool-call");
    expect(step?.label).toContain("Scout wants to close a tab");

    harness.finish();
    harness.manager.destroy();
  });

  it("refuses a second request while one is outstanding", async () => {
    // `pendingApproval` is a field, not a list. An agent firing two actions at
    // once is told no to the second rather than having it applied later against
    // a browser that has since moved.
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    void (approve as Approve)("close_tab", "first", "why", "tab-1");

    await expect((approve as Approve)("go_back", "second", "why", "tab-1")).resolves.toBe(false);
    expect(currentRun(harness)?.pendingApproval?.summary).toBe("first");

    harness.finish();
    harness.manager.destroy();
  });

  it("refuses rather than waits once the run is cancelled", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    const runId = currentRun(harness)?.id ?? "";
    const decision = (approve as Approve)("close_tab", "Scout wants to close a tab", "why", "tab-1");

    harness.manager.cancelRun(runId);

    await expect(decision).resolves.toBe(false);
    expect(currentRun(harness)?.pendingApproval).toBeNull();
    await expect((approve as Approve)("go_back", "later", "why", "tab-1")).resolves.toBe(false);

    harness.finish();
    harness.manager.destroy();
  });

  it("settles everything outstanding when the window goes", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    const decision = (approve as Approve)("close_tab", "Scout wants to close a tab", "why", "tab-1");

    harness.manager.destroy();

    // The child on the far side of the socket is holding a tool call open. It
    // gets a refusal rather than a wait that never ends.
    await expect(decision).resolves.toBe(false);
    harness.finish();
  });

  it("refuses a gate that nobody answered, and says so in the log", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    const decision = (approve as Approve)("close_tab", "Scout wants to close a tab", "why", "tab-1");
    expect(currentRun(harness)?.status).toBe("awaiting-approval");

    await advance(APPROVAL_TIMEOUT_MS + 1000);

    await expect(decision).resolves.toBe(false);
    expect(currentRun(harness)?.pendingApproval).toBeNull();
    expect(currentRun(harness)?.steps.at(-1)?.label).toContain("No answer to close_tab");
    expect(currentRun(harness)?.status).toBe("acting");

    harness.finish();
    harness.manager.destroy();
  });

  it("leaves no gate parked once the tool has exited", async () => {
    const harness = build();
    start(harness);
    const { approve } = await enter(harness);

    const decision = (approve as Approve)("close_tab", "Scout wants to close a tab", "why", "tab-1");

    // The child exits while the user is still deciding. Showing them a choice
    // that no longer decides anything would be a lie.
    harness.finish();

    await expect(decision).resolves.toBe(false);
    await advance();
    expect(currentRun(harness)?.pendingApproval).toBeNull();

    harness.manager.destroy();
  });

  it("ignores a decision on an approval that is not outstanding", async () => {
    const harness = build();
    start(harness);
    await enter(harness);

    const before = harness.snapshot();
    harness.manager.resolveApproval({ approvalId: "approval-999", decision: "allow" });
    expect(harness.snapshot().runs).toEqual(before.runs);

    harness.finish();
    harness.manager.destroy();
  });
});

/* ------------------------------------------------------------------------- */
/* An agent on an API key                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The other transport, through the whole runtime.
 *
 * A route with no local process gets its tool loop run here instead, and the
 * point of this block is that everything the socket enforces is still enforced:
 * the same tools, the same tabs, the same gate.
 */
type TurnScript = (messages: readonly ChatMessage[], withTools: boolean) => ChatOutcome;

interface HttpHarness {
  readonly manager: AgentManager;
  readonly snapshot: () => AgentSnapshot;
  readonly done: Promise<void>;
  readonly sent: () => readonly { messages: readonly ChatMessage[]; withTools: boolean }[];
  readonly toolsOffered: () => readonly string[];
}

function buildHttp(script: TurnScript, options: { readonly withTurns?: boolean } = {}): HttpHarness {
  const secrets = new SecretStore({
    credentialPath: join(directory, "agent-credentials.enc"),
    profilePath: join(directory, "agent-profile.json"),
    cipher: bufferCipher()
  });

  const sent: { messages: readonly ChatMessage[]; withTools: boolean }[] = [];
  let offered: readonly string[] = [];

  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const manager = new AgentManager({
    statePath: join(directory, "agents.json"),
    browser,
    secrets,
    publish: () => undefined,
    provider: () => {
      settle();
      return Promise.resolve({ ok: true, text: "answered without tools" });
    },
    ...(options.withTurns === false
      ? {}
      : {
          providerTurn: (request) => {
            sent.push({ messages: request.messages, withTools: request.tools.length > 0 });
            if (request.tools.length > 0) offered = request.tools.map((tool) => tool.name);
            const outcome = script(request.messages, request.tools.length > 0);
            if (outcome.ok && outcome.reply.toolCalls.length === 0) settle();
            return Promise.resolve(outcome);
          }
        })
  });

  manager.restore();
  // An HTTP orchestrator, so the route resolves to an endpoint rather than a
  // program - which is the whole point of this block.
  manager.setOrchestrator({
    provider: "anthropic",
    model: "claude-opus-5",
    baseUrl: null,
    command: null
  });

  return {
    manager,
    snapshot: () => manager.snapshot(),
    done,
    sent: () => sent,
    toolsOffered: () => offered
  };
}

function startHttp(harness: HttpHarness, tabIds: readonly string[] = ["tab-1"]): void {
  const companionId = harness.snapshot().companions[0]?.id ?? "";
  harness.manager.startRun(
    parseStartRunPayload({ companionId, task: "look at the page", tabIds: [...tabIds] })
  );
}

function httpRun(harness: HttpHarness): ReturnType<typeof activeRun> {
  return activeRun(harness.snapshot());
}

function toolCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: "call-1", name, arguments: args };
}

describe("an agent on an API key", () => {
  it("is offered the same tools an MCP client would be", async () => {
    const harness = buildHttp(() => ({ ok: true, reply: { text: "Nothing to do.", toolCalls: [] } }));
    startHttp(harness);
    await advance();

    expect(harness.toolsOffered()).toContain("list_tabs");
    expect(harness.toolsOffered()).toContain("navigate_tab");
    expect(harness.toolsOffered()).toContain("read_page");

    harness.manager.destroy();
  });

  it("sees only the tabs the user granted", async () => {
    let answer = "";
    const harness = buildHttp((messages, withTools) => {
      if (!withTools || messages.length === 1) {
        return { ok: true, reply: { text: "", toolCalls: [toolCall("list_tabs")] } };
      }
      const last = messages.at(-1);
      answer = last?.role === "tool" ? (last.answers[0]?.text ?? "") : "";
      return { ok: true, reply: { text: "Read them.", toolCalls: [] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    expect(answer).toContain("tab-1");
    expect(answer).not.toContain("tab-2");
    expect(answer).not.toContain("bank.example");

    harness.manager.destroy();
  });

  it("reads a granted page and refuses one it was not given", async () => {
    const answers: string[] = [];
    let step = 0;

    const harness = buildHttp((messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool") answers.push(last.answers[0]?.text ?? "");

      step += 1;
      if (step === 1) {
        return { ok: true, reply: { text: "", toolCalls: [toolCall("read_page", { tabId: "tab-1" })] } };
      }
      if (step === 2) {
        return { ok: true, reply: { text: "", toolCalls: [toolCall("read_page", { tabId: "tab-2" })] } };
      }
      return { ok: true, reply: { text: "Done.", toolCalls: [] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    expect(answers[0]).toContain("Giant kelp");
    expect(answers[1]).toContain("not granted");

    harness.manager.destroy();
  });

  it("stops for the user before it changes anything", async () => {
    let step = 0;
    const harness = buildHttp(() => {
      step += 1;
      return step === 1
        ? {
            ok: true,
            reply: {
              text: "",
              toolCalls: [toolCall("navigate_tab", { tabId: "tab-1", url: "https://news.test/" })]
            }
          }
        : { ok: true, reply: { text: "Navigated.", toolCalls: [] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    const request = httpRun(harness)?.pendingApproval;
    expect(httpRun(harness)?.status).toBe("awaiting-approval");
    expect(request?.toolName).toBe("navigate_tab");
    expect(request?.summary).toContain("https://news.test/");
    expect(browserActions).toEqual([]);

    harness.manager.resolveApproval({ approvalId: request?.id ?? "", decision: "allow" });
    await advance();

    expect(browserActions).toContain("navigate tab-1 https://news.test/");

    harness.manager.destroy();
  });

  it("tells the model when the user says no, and changes nothing", async () => {
    const answers: string[] = [];
    let step = 0;

    const harness = buildHttp((messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool") answers.push(last.answers[0]?.text ?? "");

      step += 1;
      return step === 1
        ? { ok: true, reply: { text: "", toolCalls: [toolCall("close_tab", { tabId: "tab-1" })] } }
        : { ok: true, reply: { text: "Left it open.", toolCalls: [] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    harness.manager.resolveApproval({
      approvalId: httpRun(harness)?.pendingApproval?.id ?? "",
      decision: "deny"
    });
    await advance();

    expect(answers[0]).toContain("declined");
    expect(browserActions).toEqual([]);
    expect(httpRun(harness)?.status).toBe("done");

    harness.manager.destroy();
  });

  it("writes what it did into the run log", async () => {
    let step = 0;
    const harness = buildHttp(() => {
      step += 1;
      return step === 1
        ? {
            ok: true,
            reply: {
              text: "I will read the kelp page.",
              toolCalls: [toolCall("read_page", { tabId: "tab-1" })]
            }
          }
        : { ok: true, reply: { text: "It is about kelp.", toolCalls: [] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    const steps = httpRun(harness)?.steps ?? [];
    const kinds = steps.map((entry) => entry.kind);

    expect(kinds).toContain("thought");
    expect(kinds).toContain("tool-call");
    expect(kinds).toContain("tool-result");
    expect(steps.find((entry) => entry.kind === "tool-call")?.label).toContain("read_page");
    expect(steps.find((entry) => entry.kind === "tool-call")?.tabId).toBe("tab-1");
    expect(steps.at(-1)?.detail).toContain("It is about kelp.");

    harness.manager.destroy();
  });

  it("grants itself a tab it opened, and nothing else", async () => {
    const answers: string[] = [];
    let step = 0;

    const harness = buildHttp((messages) => {
      const last = messages.at(-1);
      if (last?.role === "tool") answers.push(last.answers[0]?.text ?? "");

      step += 1;
      if (step === 1) {
        return {
          ok: true,
          reply: { text: "", toolCalls: [toolCall("open_tab", { url: "https://a.test/" })] }
        };
      }
      if (step === 2) return { ok: true, reply: { text: "", toolCalls: [toolCall("list_tabs")] } };
      return { ok: true, reply: { text: "Done.", toolCalls: [] } };
    });

    startHttp(harness, []);
    await advance();

    harness.manager.resolveApproval({
      approvalId: httpRun(harness)?.pendingApproval?.id ?? "",
      decision: "allow"
    });
    await advance();

    expect(browserActions).toContain("createTab primary https://a.test/");
    expect(answers[1]).toContain("tab-9");
    expect(answers[1]).not.toContain("tab-1");

    harness.manager.destroy();
  });

  it("cancelling while a gate is open stops the loop rather than only the gate", async () => {
    let turns = 0;
    const harness = buildHttp(() => {
      turns += 1;
      return { ok: true, reply: { text: "", toolCalls: [toolCall("close_tab", { tabId: "tab-1" })] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    // Parked on the approval, which is where a run actually sits when a user
    // reaches for cancel.
    expect(httpRun(harness)?.status).toBe("awaiting-approval");
    const turnsWhenParked = turns;

    harness.manager.cancelRun(httpRun(harness)?.id ?? "");
    await advance();

    expect(httpRun(harness)?.status).toBe("cancelled");
    expect(httpRun(harness)?.pendingApproval).toBeNull();
    expect(browserActions).toEqual([]);
    // The refused gate released the loop, and the loop then saw the run was
    // cancelled rather than carrying on to another turn.
    expect(turns).toBe(turnsWhenParked);

    harness.manager.destroy();
  });

  it("shows the user what it read without writing the page to disk", async () => {
    let step = 0;
    const harness = buildHttp(() => {
      step += 1;
      return step === 1
        ? { ok: true, reply: { text: "", toolCalls: [toolCall("read_page", { tabId: "tab-1" })] } }
        : { ok: true, reply: { text: "It is about kelp.", toolCalls: [] } };
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    // The panel can show it: this is what makes a run reviewable.
    const results = (httpRun(harness)?.steps ?? []).filter((entry) => entry.kind === "tool-result");
    expect(results.at(-1)?.detail).toContain("Giant kelp");

    // The file cannot. A signed-in page's text must not outlive the window in
    // plain JSON on disk.
    harness.manager.destroy();
    const written = readFileSync(join(directory, "agents.json"), "utf8");

    expect(written).not.toContain("Giant kelp");
    expect(written).toContain("read_page");
  });

  it("answers from the task alone in a build with no turn transport", async () => {
    // The behaviour every HTTP route had before the browser was reachable.
    const harness = buildHttp(() => ({ ok: true, reply: { text: "x", toolCalls: [] } }), {
      withTurns: false
    });

    startHttp(harness, ["tab-1"]);
    await advance();

    expect(harness.sent()).toEqual([]);
    expect(httpRun(harness)?.steps.at(-1)?.detail).toBe("answered without tools");

    harness.manager.destroy();
  });
});
