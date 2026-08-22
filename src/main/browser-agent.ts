/**
 * Driving a model that can use the browser, over an ordinary HTTP provider.
 *
 * A local coding CLI arrives already knowing how to run a tool loop, so giving
 * it the browser is a matter of exposing a socket it can speak MCP to. A model
 * behind an API key does not: it will answer a question, and if it is handed
 * tool definitions it will ask for one, but somebody has to make the second
 * request. That somebody is this file.
 *
 * It is the same feature as the MCP server, seen from the other side. Both end
 * at `runNamedBrowserTool`, so both get the identical closed tool set, the
 * identical grant boundary, and the identical approval gate. What differs is
 * only who is holding the conversation: a separate process there, this loop
 * here.
 *
 * Three things bound it, because an agentic loop on somebody's paid key is a
 * thing that must not be able to run away:
 *
 *   1. **Turns are capped.** Past the cap the model is asked once more, with the
 *      tools withdrawn, so the run ends with an answer rather than with nothing.
 *   2. **The transcript is capped.** A page read is large, and twelve of them is
 *      a request nobody wants to pay for. Passing the cap ends the loop the same
 *      way the turn cap does.
 *   3. **Cancellation is checked between every step**, so stopping a run stops
 *      it inside a tool loop and not only between requests.
 */
import {
  MAX_TOOL_TURNS,
  MAX_TRANSCRIPT_CHARS,
  transcriptSize,
  type ChatMessage,
  type ChatOutcome,
  type ProviderErrorCode,
  type ProviderResult,
  type ToolAnswer,
  type ToolCall,
  type ToolImage
} from "../shared/provider-request.js";

/** What the loop did, as the run log wants to hear it. */
export type BrowserAgentEvent =
  | { readonly kind: "thought"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly tool: string;
      readonly detail: string | null;
      /** So the chrome can offer to reveal the tab a step touched. */
      readonly tabId: string | null;
    }
  | {
      readonly kind: "tool-result";
      readonly tool: string;
      readonly detail: string;
      readonly failed: boolean;
      readonly tabId: string | null;
    };

export interface BrowserAgentOptions {
  /** The task, already scrubbed and bounded by the IPC boundary. */
  readonly task: string;
  /**
   * One request. `withTools` is false for the closing turn, and for the retry
   * described below.
   */
  readonly turn: (
    messages: readonly ChatMessage[],
    withTools: boolean,
    signal: AbortSignal
  ) => Promise<ChatOutcome>;
  /** Runs one tool by the name and arguments the model produced. Never throws. */
  readonly runTool: (call: ToolCall) => Promise<{
    text: string;
    isError: boolean;
    image: ToolImage | null;
  }>;
  readonly record?: (event: BrowserAgentEvent) => void;
  readonly signal: AbortSignal;
  readonly maxTurns?: number;
  /**
   * The route's context window in tokens, or null to use the shipped bound.
   *
   * The loop stops growing the transcript before it exceeds what the model can
   * hold. Without this a route on a small window fails at the provider, several
   * tool calls in, with an error the user cannot connect to a setting — whereas
   * a loop that stops early still produces an answer from what it has.
   */
  readonly contextWindow?: number | null;
}

/** How much of a tool's answer is written into the run log. */
const LOGGED_RESULT_LENGTH = 2000;

/**
 * How many images one run may put into its transcript.
 *
 * The transcript budget alone would let a model spend the whole window on
 * pictures of the same page, and a model that has started taking screenshots
 * tends to keep taking them. A separate count is what stops that in a way the
 * model is told about, so it goes back to the snapshot rather than to a wall.
 */
export const MAX_SCREENSHOTS_PER_RUN = 4;

/**
 * The nudge that ends a loop which has run out of room.
 *
 * Sent as an ordinary user message with the tools withdrawn, so the model has
 * nothing to do but answer. Withdrawing the tools rather than only asking is
 * what makes it reliable: a model that can still see a tool will often reach for
 * one more.
 */
/**
 * Characters per token, for turning a declared window into a character budget.
 *
 * English prose runs near four; the mixture here — page text, URLs, JSON tool
 * arguments — runs shorter, so three is used. Under-estimating is the safe
 * direction: it stops the loop early, which costs a tool call, where
 * over-estimating costs the whole request at the provider.
 */
const CHARS_PER_TOKEN = 3;

/**
 * The share of the window the transcript may occupy.
 *
 * The rest is the model's own reply, the tool declarations, and whatever the
 * provider prepends. Two thirds leaves room for all of it without needing to
 * count any of it exactly.
 */
const TRANSCRIPT_SHARE = 2 / 3;

/**
 * How many characters of transcript this route can afford.
 *
 * Never larger than the shipped bound. A route declaring a million-token window
 * is describing what the model accepts, not what this app should send in one
 * request — so the declared window can only ever tighten the budget.
 */
export function transcriptBudgetFor(contextWindow: number | null): number {
  if (contextWindow === null || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return MAX_TRANSCRIPT_CHARS;
  }
  const budget = Math.floor(contextWindow * TRANSCRIPT_SHARE * CHARS_PER_TOKEN);
  return Math.min(MAX_TRANSCRIPT_CHARS, Math.max(1, budget));
}

const CLOSING_NUDGE =
  "You have used all the browser access available for this task. " +
  "Answer now with what you already have, and say plainly what you could not find out.";

/**
 * Runs the task to an answer.
 *
 * Never throws. Every ending - an answer, a cancelled run, a provider that
 * refused, a loop that ran out of room - comes back as a `ProviderResult` the
 * caller turns into a step.
 */
export async function runBrowserAgent(options: BrowserAgentOptions): Promise<ProviderResult> {
  const maxTurns = options.maxTurns ?? MAX_TOOL_TURNS;
  const transcriptBudget = transcriptBudgetFor(options.contextWindow ?? null);
  const messages: ChatMessage[] = [{ role: "user", text: options.task }];

  let lastText = "";
  let screenshots = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (options.signal.aborted) return { ok: false, code: "cancelled" };

    let outcome = await options.turn(messages, true, options.signal);

    /*
     * A model that cannot be sent tools at all.
     *
     * Not every model behind an OpenAI-compatible endpoint accepts a `tools`
     * field, and one that does not refuses the whole request. Before tools
     * existed that route answered fine, so failing it now would be this feature
     * breaking a working configuration. The retry happens only on the first
     * turn, where no tool has been called yet and re-asking costs one request:
     * later in a conversation a refusal is about the conversation, not about
     * whether tools are supported.
     */
    if (!outcome.ok && turn === 0 && isPossiblyToolRefusal(outcome.code)) {
      outcome = await options.turn(messages, false, options.signal);
      if (outcome.ok) {
        return outcome.reply.text.length > 0
          ? { ok: true, text: outcome.reply.text }
          : { ok: false, code: "malformed-reply" };
      }
    }

    if (!outcome.ok) return outcome;

    const { text, toolCalls } = outcome.reply;
    if (text.length > 0) {
      lastText = text;
      // Recorded even when the turn goes on to call a tool: a model that
      // explains what it is about to do is the most useful thing in the log.
      if (toolCalls.length > 0) options.record?.({ kind: "thought", text });
    }

    if (toolCalls.length === 0) {
      return text.length > 0 ? { ok: true, text } : { ok: false, code: "malformed-reply" };
    }

    messages.push({ role: "assistant", text, toolCalls });

    const answers: ToolAnswer[] = [];
    for (const call of toolCalls) {
      if (options.signal.aborted) return { ok: false, code: "cancelled" };

      // Read from the arguments rather than from the result, so a call that was
      // refused still names the tab it was about.
      const tabId = typeof call.arguments["tabId"] === "string" ? call.arguments["tabId"] : null;

      options.record?.({
        kind: "tool-call",
        tool: call.name,
        detail: describeArguments(call.arguments),
        tabId
      });

      const result = await options.runTool(call);

      options.record?.({
        kind: "tool-result",
        tool: call.name,
        detail: result.text.slice(0, LOGGED_RESULT_LENGTH),
        failed: result.isError,
        tabId
      });

      /*
       * Past the cap the answer keeps its words and loses its picture. Dropping
       * the whole result would lose what the tool said as well, and the cap is
       * about what the transcript can afford to carry, not about whether the
       * call was allowed to happen.
       */
      const image = result.image === null || screenshots >= MAX_SCREENSHOTS_PER_RUN ? null : result.image;
      if (image !== null) screenshots += 1;

      answers.push({
        id: call.id,
        name: call.name,
        text:
          result.image !== null && image === null
            ? `${result.text}\n\n[This run has already sent ${String(MAX_SCREENSHOTS_PER_RUN)} images, so this one was not included. Use snapshot instead.]`
            : result.text,
        isError: result.isError,
        image
      });
    }

    messages.push({ role: "tool", answers });

    if (transcriptSize(messages) > transcriptBudget) break;
  }

  if (options.signal.aborted) return { ok: false, code: "cancelled" };

  /*
   * Out of room. One more request, with nothing to call, so the user gets an
   * answer rather than a run that stopped mid-thought.
   */
  messages.push({ role: "user", text: CLOSING_NUDGE });
  const closing = await options.turn(messages, false, options.signal);

  if (closing.ok && closing.reply.text.length > 0) {
    return { ok: true, text: closing.reply.text };
  }

  // Even the closing turn failed. Whatever the model last said is still a
  // better answer than a code, so it is preferred when there is one.
  return lastText.length > 0
    ? { ok: true, text: lastText }
    : closing.ok
      ? { ok: false, code: "malformed-reply" }
      : closing;
}

/**
 * Whether a failure could plausibly be "this model does not take tools".
 *
 * Read from the status code rather than the provider's error text, which is
 * remote content this application does not parse for meaning. That makes this a
 * guess, which is why it only ever costs one extra request and only on the turn
 * where no work has been done yet.
 */
function isPossiblyToolRefusal(code: ProviderErrorCode): boolean {
  return code === "provider-error" || code === "malformed-reply";
}

/** A one-line rendering of a call's arguments, for the run log. */
function describeArguments(args: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") parts.push(`${key}: ${value.slice(0, 200)}`);
    else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}
