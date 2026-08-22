/**
 * The loop that lets an agent on an API key use the browser.
 *
 * Nothing here talks to a provider or a tab. The turn port and the tool port are
 * both scripted, so what is under test is the loop itself: that it ends, that it
 * ends with an answer rather than with nothing, that a cancelled run stops
 * inside a tool sequence and not only between requests, and that a model which
 * cannot be sent tools at all still gets its question answered.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runBrowserAgent,
  transcriptBudgetFor,
  type BrowserAgentEvent
} from "./browser-agent.js";
import {
  MAX_TOOL_TURNS,
  MAX_TRANSCRIPT_CHARS,
  type ChatMessage,
  type ChatOutcome,
  type ToolCall
} from "../shared/provider-request.js";

function says(text: string): ChatOutcome {
  return { ok: true, reply: { text, toolCalls: [] } };
}

function asks(text: string, ...calls: readonly ToolCall[]): ChatOutcome {
  return { ok: true, reply: { text, toolCalls: calls } };
}

function call(name: string, args: Record<string, unknown> = {}, id = "c1"): ToolCall {
  return { id, name, arguments: args };
}

/** A turn port driven from a script, recording what it was sent. */
function scripted(outcomes: readonly ChatOutcome[]): {
  turn: (
    messages: readonly ChatMessage[],
    withTools: boolean,
    signal: AbortSignal
  ) => Promise<ChatOutcome>;
  sent: { messages: readonly ChatMessage[]; withTools: boolean }[];
} {
  const sent: { messages: readonly ChatMessage[]; withTools: boolean }[] = [];
  let index = 0;

  return {
    sent,
    turn: (messages, withTools) => {
      sent.push({ messages: messages.map((entry) => entry), withTools });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return Promise.resolve(outcome ?? says("fallback"));
    }
  };
}

const liveSignal = (): AbortSignal => new AbortController().signal;

describe("ending with an answer", () => {
  it("returns prose when the model asks for no tool", async () => {
    const { turn, sent } = scripted([says("Kelp grows fast.")]);

    const result = await runBrowserAgent({
      task: "tell me about kelp",
      turn,
      runTool: () => Promise.resolve({ text: "", isError: false }),
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: true, text: "Kelp grows fast." });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.withTools).toBe(true);
  });

  it("runs a tool and feeds the answer back on the next turn", async () => {
    const { turn, sent } = scripted([
      asks("Let me look.", call("read_page", { tabId: "tab-1" })),
      says("It is about kelp.")
    ]);

    const runTool = vi.fn(() => Promise.resolve({ text: "A page about kelp.", isError: false }));

    const result = await runBrowserAgent({
      task: "what is in tab-1",
      turn,
      runTool,
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: true, text: "It is about kelp." });
    expect(runTool).toHaveBeenCalledTimes(1);

    // The second request carries the whole conversation: the question, what the
    // model asked for, and what it got back.
    const second = sent[1]?.messages ?? [];
    expect(second).toHaveLength(3);
    expect(second[1]).toMatchObject({ role: "assistant" });
    expect(second[2]).toMatchObject({
      role: "tool",
      answers: [{ id: "c1", name: "read_page", text: "A page about kelp.", isError: false }]
    });
  });

  it("runs every call in a turn that asked for several", async () => {
    const { turn } = scripted([
      asks(
        "",
        call("list_tabs", {}, "a"),
        call("read_page", { tabId: "tab-1" }, "b")
      ),
      says("Done.")
    ]);

    const seen: string[] = [];
    await runBrowserAgent({
      task: "look around",
      turn,
      runTool: (received) => {
        seen.push(received.name);
        return Promise.resolve({ text: "ok", isError: false });
      },
      signal: liveSignal()
    });

    expect(seen).toEqual(["list_tabs", "read_page"]);
  });

  it("passes a failed tool back as an answer rather than giving up", async () => {
    const { turn, sent } = scripted([
      asks("", call("close_tab", { tabId: "tab-1" })),
      says("They said no, so I left it open.")
    ]);

    const result = await runBrowserAgent({
      task: "close it",
      turn,
      runTool: () => Promise.resolve({ text: "The user declined this.", isError: true }),
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: true, text: "They said no, so I left it open." });

    const answers = (sent[1]?.messages[2] as { answers: { isError: boolean }[] }).answers;
    expect(answers[0]?.isError).toBe(true);
  });
});

describe("bounds", () => {
  it("stops calling tools at the turn cap and asks once more for an answer", async () => {
    // A model that will call a tool forever.
    const { turn, sent } = scripted([asks("", call("list_tabs"))]);
    let closingAnswer = false;

    const result = await runBrowserAgent({
      task: "keep going",
      turn: (messages, withTools, signal) => {
        if (!withTools) {
          closingAnswer = true;
          return Promise.resolve(says("Here is what I found."));
        }
        return turn(messages, withTools, signal);
      },
      runTool: () => Promise.resolve({ text: "one tab", isError: false }),
      maxTurns: 3,
      signal: liveSignal()
    });

    expect(closingAnswer).toBe(true);
    expect(result).toEqual({ ok: true, text: "Here is what I found." });
    expect(sent).toHaveLength(3);
  });

  it("withdraws the tools on the closing turn rather than only asking", async () => {
    const withTools: boolean[] = [];

    await runBrowserAgent({
      task: "keep going",
      turn: (_messages, tools) => {
        withTools.push(tools);
        return Promise.resolve(tools ? asks("", call("list_tabs")) : says("Finished."));
      },
      runTool: () => Promise.resolve({ text: "one tab", isError: false }),
      maxTurns: 2,
      signal: liveSignal()
    });

    expect(withTools).toEqual([true, true, false]);
  });

  it("stops on the transcript cap even under the turn cap", async () => {
    let turns = 0;

    const result = await runBrowserAgent({
      task: "read everything",
      turn: (_messages, tools) => {
        if (!tools) return Promise.resolve(says("Enough."));
        turns += 1;
        return Promise.resolve(asks("", call("read_page", { tabId: "tab-1" })));
      },
      // One page read is most of the budget, so two of them end it.
      runTool: () => Promise.resolve({ text: "x".repeat(70_000), isError: false }),
      maxTurns: MAX_TOOL_TURNS,
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: true, text: "Enough." });
    expect(turns).toBeLessThan(MAX_TOOL_TURNS);
  });

  it("keeps the model's last words when even the closing turn fails", async () => {
    const result = await runBrowserAgent({
      task: "keep going",
      turn: (_messages, tools) =>
        Promise.resolve(
          tools
            ? asks("Halfway through, I saw two tabs.", call("list_tabs"))
            : { ok: false, code: "rate-limited" }
        ),
      runTool: () => Promise.resolve({ text: "two tabs", isError: false }),
      maxTurns: 1,
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: true, text: "Halfway through, I saw two tabs." });
  });
});

describe("failure and cancellation", () => {
  it("reports a provider that refused", async () => {
    const result = await runBrowserAgent({
      task: "hello",
      turn: () => Promise.resolve({ ok: false, code: "unauthorised" }),
      runTool: () => Promise.resolve({ text: "", isError: false }),
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: false, code: "unauthorised" });
  });

  it("retries once without tools when the first turn may have refused them", async () => {
    // Not every model behind an OpenAI-compatible endpoint accepts a `tools`
    // field, and one that does not refuses the whole request. Before tools
    // existed that route answered fine.
    const withTools: boolean[] = [];

    const result = await runBrowserAgent({
      task: "hello",
      turn: (_messages, tools) => {
        withTools.push(tools);
        return Promise.resolve(tools ? { ok: false, code: "provider-error" } : says("Hello back."));
      },
      runTool: () => Promise.resolve({ text: "", isError: false }),
      signal: liveSignal()
    });

    expect(withTools).toEqual([true, false]);
    expect(result).toEqual({ ok: true, text: "Hello back." });
  });

  it("does not retry a failure that says nothing about tools", async () => {
    const attempts: boolean[] = [];

    const result = await runBrowserAgent({
      task: "hello",
      turn: (_messages, tools) => {
        attempts.push(tools);
        return Promise.resolve({ ok: false, code: "unauthorised" });
      },
      runTool: () => Promise.resolve({ text: "", isError: false }),
      signal: liveSignal()
    });

    expect(attempts).toEqual([true]);
    expect(result).toEqual({ ok: false, code: "unauthorised" });
  });

  it("does not retry after work has already been done", async () => {
    let turns = 0;

    const result = await runBrowserAgent({
      task: "hello",
      turn: () => {
        turns += 1;
        return Promise.resolve(
          turns === 1 ? asks("", call("list_tabs")) : { ok: false, code: "provider-error" }
        );
      },
      runTool: () => Promise.resolve({ text: "one tab", isError: false }),
      signal: liveSignal()
    });

    expect(result).toEqual({ ok: false, code: "provider-error" });
    expect(turns).toBe(2);
  });

  it("stops before the first request when the run was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const turn = vi.fn();

    const result = await runBrowserAgent({
      task: "hello",
      turn: turn as never,
      runTool: () => Promise.resolve({ text: "", isError: false }),
      signal: controller.signal
    });

    expect(result).toEqual({ ok: false, code: "cancelled" });
    expect(turn).not.toHaveBeenCalled();
  });

  it("stops between tool calls, not only between requests", async () => {
    const controller = new AbortController();
    const ran: string[] = [];

    const result = await runBrowserAgent({
      task: "look around",
      turn: () =>
        Promise.resolve(asks("", call("list_tabs", {}, "a"), call("read_page", { tabId: "t" }, "b"))),
      runTool: (received) => {
        ran.push(received.name);
        controller.abort();
        return Promise.resolve({ text: "ok", isError: false });
      },
      signal: controller.signal
    });

    expect(result).toEqual({ ok: false, code: "cancelled" });
    expect(ran).toEqual(["list_tabs"]);
  });
});

describe("what the run log is told", () => {
  it("records the thought, the call, and the answer", async () => {
    const events: BrowserAgentEvent[] = [];
    const { turn } = scripted([
      asks("I will read the first tab.", call("read_page", { tabId: "tab-1" })),
      says("It is about kelp.")
    ]);

    await runBrowserAgent({
      task: "what is in tab-1",
      turn,
      runTool: () => Promise.resolve({ text: "A page about kelp.", isError: false }),
      record: (event) => events.push(event),
      signal: liveSignal()
    });

    expect(events.map((event) => event.kind)).toEqual(["thought", "tool-call", "tool-result"]);
    expect(events[0]).toMatchObject({ text: "I will read the first tab." });
    expect(events[1]).toMatchObject({ tool: "read_page", tabId: "tab-1" });
    expect(events[2]).toMatchObject({ tool: "read_page", failed: false, tabId: "tab-1" });
  });

  it("names the tab a refused call was about", async () => {
    const events: BrowserAgentEvent[] = [];
    const { turn } = scripted([
      asks("", call("close_tab", { tabId: "tab-4" })),
      says("Left it open.")
    ]);

    await runBrowserAgent({
      task: "close tab-4",
      turn,
      runTool: () => Promise.resolve({ text: "The user declined this.", isError: true }),
      record: (event) => events.push(event),
      signal: liveSignal()
    });

    const result = events.find((event) => event.kind === "tool-result");
    expect(result).toMatchObject({ failed: true, tabId: "tab-4" });
  });

  it("does not record a final answer as a thought", async () => {
    // The last turn's prose is the reply, and the caller writes that itself.
    const events: BrowserAgentEvent[] = [];

    await runBrowserAgent({
      task: "hello",
      turn: () => Promise.resolve(says("Hello back.")),
      runTool: () => Promise.resolve({ text: "", isError: false }),
      record: (event) => events.push(event),
      signal: liveSignal()
    });

    expect(events).toEqual([]);
  });

  it("bounds what one tool answer writes into the log", async () => {
    const events: BrowserAgentEvent[] = [];
    const { turn } = scripted([asks("", call("read_page", { tabId: "t" })), says("Done.")]);

    await runBrowserAgent({
      task: "read it",
      turn,
      runTool: () => Promise.resolve({ text: "z".repeat(50_000), isError: false }),
      record: (event) => events.push(event),
      signal: liveSignal()
    });

    const result = events.find((event) => event.kind === "tool-result");
    expect((result as { detail: string }).detail.length).toBeLessThanOrEqual(2000);
  });
});

describe("transcriptBudgetFor", () => {
  it("uses the shipped bound when no window is declared", () => {
    expect(transcriptBudgetFor(null)).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it("tightens the budget for a model with a small window", () => {
    // Three characters per token, two thirds of the window: the rest is the
    // reply, the tool declarations, and whatever the provider prepends.
    expect(transcriptBudgetFor(8192)).toBe(Math.floor(8192 * (2 / 3) * 3));
    expect(transcriptBudgetFor(8192)).toBeLessThan(MAX_TRANSCRIPT_CHARS);
  });

  it("never loosens it past what this app will send in one request", () => {
    /*
     * A million-token window describes what the model accepts, not what this app
     * should put in one request. The declared window can only ever tighten.
     */
    expect(transcriptBudgetFor(1_048_576)).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it("falls back rather than producing a budget of nothing", () => {
    expect(transcriptBudgetFor(0)).toBe(MAX_TRANSCRIPT_CHARS);
    expect(transcriptBudgetFor(-1)).toBe(MAX_TRANSCRIPT_CHARS);
    expect(transcriptBudgetFor(Number.NaN)).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it("stays at least one character for an absurdly small window", () => {
    expect(transcriptBudgetFor(1)).toBeGreaterThanOrEqual(1);
  });
});
