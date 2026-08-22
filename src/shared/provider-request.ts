/**
 * Shaping a provider request, and reading the reply.
 *
 * The split here is the point: **this module never sees a credential.** It
 * builds a URL, a header set without authorisation, and a body; the trusted
 * process adds the key immediately before sending and never puts it anywhere
 * else. A module that cannot receive a secret cannot leak one, which makes the
 * larger half of this feature reviewable without reasoning about key handling at
 * all.
 *
 * Everything a provider returns is treated as hostile. A reply is JSON from a
 * remote host, so the text is extracted defensively, bounded, and reduced -
 * exactly as reader mode treats a page.
 *
 * Pure ASCII, so the endpoint table stays reviewable.
 */

import type { ProviderId } from "./agents.js";
import type { McpToolDescriptor } from "./mcp.js";

/** Bounds a reply. Generous for prose, far short of anything pathological. */
export const MAX_REPLY_LENGTH = 16_000;

/** Bounds the prompt sent. The task is already capped well below this. */
export const MAX_PROMPT_LENGTH = 8_000;

/**
 * Bounds one tool result placed into a transcript.
 *
 * A page read is already bounded where it is produced. This is the second
 * bound, applied at the transport, because a transcript grows by a result on
 * every turn and the thing being protected here is the context window rather
 * than the trusted process.
 */
export const MAX_TOOL_RESULT_LENGTH = 24_000;

/**
 * Bounds a whole conversation.
 *
 * The turn cap alone is not enough: twelve turns of large pages is a request
 * nobody wants to pay for. When this is passed the loop stops and reports what
 * it has, which is a better outcome than a request that is refused for length
 * after the work was already done.
 */
export const MAX_TRANSCRIPT_CHARS = 120_000;

/**
 * How many times a model may call tools before it must answer.
 *
 * A loop that cannot end is the failure mode of every agentic transport, and a
 * turn here costs a request and a page read.
 *
 * Twelve was the right number when the tools could only read: open a tab, read
 * it, follow a link, report. A loop that also acts spends turns differently —
 * snapshot, act, read the diff, snapshot again — so filling in a form and
 * checking the result is most of a dozen turns before any of the actual task
 * happens. Twenty-four covers that and is still nowhere near enough to browse
 * indefinitely on someone's key without them noticing. The transcript budget is
 * the real backstop and usually bites first.
 */
export const MAX_TOOL_TURNS = 24;

/** How long a request may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Bounds the response body read off the wire. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * What can go wrong, as codes.
 *
 * Codes rather than messages, because a provider's own error text is remote
 * content that could carry anything - including, from a misconfigured gateway,
 * fragments of a request. The chrome renders wording it holds itself.
 */
export const PROVIDER_ERRORS = [
  "no-credential",
  "unsupported-provider",
  "bad-endpoint",
  "network",
  "timeout",
  "redirected",
  "unauthorised",
  "rate-limited",
  "provider-error",
  "malformed-reply",
  "too-large",
  "cancelled",
  // Local command routes.
  "command-not-allowed",
  "command-failed",
  "no-output"
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERRORS)[number];

export type ProviderResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: ProviderErrorCode };

/**
 * What trying a configuration produced.
 *
 * A code and a duration, never the provider's reply. The reply to a test is
 * remote text that nothing has reviewed, and putting it on screen to prove the
 * route works would be showing the user the one thing this app is careful never
 * to show them. That the call completed is the whole answer.
 */
export type ProviderTestResult =
  | { readonly ok: true; readonly elapsedMs: number }
  | { readonly ok: false; readonly code: ProviderErrorCode };

/**
 * The wire dialects this app speaks.
 *
 * Two, not nine. Most hosted providers expose an OpenAI-compatible chat
 * endpoint, and Anthropic has its own; adding a provider is usually adding a row
 * to the table below rather than a third dialect.
 */
export type ProviderDialect = "anthropic" | "openai" | "ollama" | "google";

/**
 * Google addresses the model in the URL path rather than in the body.
 *
 * That makes the model name part of a URL, and the model name is user-typed. It
 * is percent-encoded here, and a name carrying a path separator is refused
 * outright rather than encoded: `../../` would otherwise walk out of the API
 * version prefix and address a different endpoint entirely. Encoding alone would
 * defeat that, but refusing is clearer about what is not supported.
 */
export function googleModelPath(model: string): string | null {
  const named = model.trim();
  if (named.length === 0) return null;
  if (named.includes("/") || named.includes("\\") || named.includes("..")) return null;

  return `/v1beta/models/${encodeURIComponent(named)}:generateContent`;
}

interface EndpointSpec {
  readonly dialect: ProviderDialect;
  /** Used when the user named no base URL. Always https, except a local runtime. */
  readonly defaultBaseUrl: string;
}

const ENDPOINTS: Readonly<Partial<Record<ProviderId, EndpointSpec>>> = {
  anthropic: { dialect: "anthropic", defaultBaseUrl: "https://api.anthropic.com" },
  openai: { dialect: "openai", defaultBaseUrl: "https://api.openai.com/v1" },
  openrouter: { dialect: "openai", defaultBaseUrl: "https://openrouter.ai/api/v1" },
  omniroute: { dialect: "openai", defaultBaseUrl: "https://api.omniroute.ai/v1" },
  moonshot: { dialect: "openai", defaultBaseUrl: "https://api.moonshot.cn/v1" },
  qwen: { dialect: "openai", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  google: { dialect: "google", defaultBaseUrl: "https://generativelanguage.googleapis.com" },
  "openai-compatible": { dialect: "openai", defaultBaseUrl: "" },
  ollama: { dialect: "ollama", defaultBaseUrl: "http://127.0.0.1:11434" }
};

export function dialectFor(provider: ProviderId): ProviderDialect | null {
  return ENDPOINTS[provider]?.dialect ?? null;
}

/**
 * The URL to call.
 *
 * A user-supplied base URL wins, and is required to be https by the validator
 * that accepted it. The one exception is the local runtime, whose default is
 * loopback: a request that never leaves the machine is not one TLS protects
 * anything about, and demanding https there would make a local model
 * unreachable for no gain.
 */
export function endpointFor(
  provider: ProviderId,
  baseUrl: string | null
): { readonly url: string; readonly dialect: ProviderDialect } | null {
  const spec = ENDPOINTS[provider];
  if (spec === undefined) return null;

  const base = (baseUrl ?? "").trim().length > 0 ? (baseUrl as string).trim() : spec.defaultBaseUrl;
  if (base.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }

  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";

  // Everything that leaves the machine carries a key, so it goes over TLS.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return null;
  }

  const root = `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;

  // Google's path carries the model, so it is composed in `buildChatRequest`
  // where the model is known. The root is all that can be settled here.
  if (spec.dialect === "google") return { url: root, dialect: spec.dialect };

  const path =
    spec.dialect === "anthropic"
      ? "/v1/messages"
      : spec.dialect === "ollama"
        ? "/api/chat"
        : "/chat/completions";

  // A base URL that already names the endpoint is honoured as given, so a user
  // who pasted a full URL is not left with it doubled.
  return {
    url: root.endsWith(path) ? root : `${root}${path}`,
    dialect: spec.dialect
  };
}

export interface ChatRequest {
  readonly url: string;
  readonly dialect: ProviderDialect;
  /** Headers *without* authorisation. The trusted process adds that. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/* -------------------------------------------------------------------------- */
/* Transcripts and tools                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One tool call a model asked for.
 *
 * `id` is how the answer is matched to the question. Two of the four dialects
 * assign one and two do not, so this app mints its own for the ones that do
 * not, and drops it again when rendering their bodies. Keeping the field
 * present everywhere is what lets the loop above be written once.
 */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** An image a tool produced, already encoded and bounded by whoever made it. */
export interface ToolImage {
  readonly mediaType: "image/png" | "image/jpeg";
  /** Base64, with no data-URI prefix; each dialect adds whatever it needs. */
  readonly data: string;
}

/**
 * What a tool answered, on its way back to the model.
 *
 * The text is always present, image or not: it is what a model reads to know
 * what it is looking at, and it is where the untrusted-content marker lives.
 */
export interface ToolAnswer {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly isError: boolean;
  readonly image: ToolImage | null;
}

/**
 * The conversation, in a shape no provider uses.
 *
 * Deliberately neutral. Each dialect renders it on the way out and parses back
 * into it on the way in, so the loop that drives a run never learns which
 * provider it is talking to - and a provider added later is a rendering, not a
 * second loop.
 */
export type ChatMessage =
  | { readonly role: "user"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
    }
  | { readonly role: "tool"; readonly answers: readonly ToolAnswer[] };

/** What came back from one turn: prose, tool calls, or both. */
export interface ChatReply {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

export type ChatOutcome =
  | { readonly ok: true; readonly reply: ChatReply }
  | { readonly ok: false; readonly code: ProviderErrorCode };

export interface ChatTurnOptions {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly messages: readonly ChatMessage[];
  /** Empty for a plain question, which is what keeps that path unchanged. */
  readonly tools?: readonly McpToolDescriptor[];
  readonly system?: string | null;
  /**
   * Sampling temperature, or null to send none.
   *
   * Null and 0 are different requests: null leaves the field out of the body
   * entirely and takes whatever the provider defaults to, while 0 asks for
   * greedy decoding. Collapsing them would make "unset" mean "deterministic",
   * which is not what an empty box in a form means.
   */
  readonly temperature?: number | null;
}

/**
 * The temperature field for one dialect, or nothing at all.
 *
 * Every dialect here spells it `temperature` except Google, which nests it in
 * `generationConfig`, and Ollama, which puts it under `options`. Written once so
 * a caller passing a temperature cannot silently have it dropped by whichever
 * branch it lands in.
 */
function temperatureField(
  dialect: ProviderDialect,
  temperature: number | null | undefined
): Record<string, unknown> {
  if (temperature === null || temperature === undefined) return {};
  if (!Number.isFinite(temperature)) return {};

  if (dialect === "google") return { generationConfig: { temperature } };
  if (dialect === "ollama") return { options: { temperature } };
  return { temperature };
}

/**
 * What one image costs against the transcript budget.
 *
 * An image is not characters, and its base64 length is a poor proxy - a
 * megabyte of PNG is nothing like a megabyte of prose to a model that bills it
 * by tile. This is a flat estimate on the generous side of what a
 * viewport-sized capture actually costs, chosen so that a loop which keeps
 * taking screenshots runs out of budget rather than out of context window.
 */
export const IMAGE_TRANSCRIPT_COST = 4000;

/** The characters a transcript currently occupies, for the total bound. */
export function transcriptSize(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "user") total += message.text.length;
    else if (message.role === "assistant") {
      total += message.text.length;
      for (const call of message.toolCalls) {
        total += call.name.length + JSON.stringify(call.arguments).length;
      }
    } else {
      for (const answer of message.answers) {
        total += answer.text.length;
        if (answer.image !== null) total += IMAGE_TRANSCRIPT_COST;
      }
    }
  }
  return total;
}

function boundedResult(text: string): string {
  return text.length > MAX_TOOL_RESULT_LENGTH ? text.slice(0, MAX_TOOL_RESULT_LENGTH) : text;
}

/**
 * A tool's schema, as one dialect will accept it.
 *
 * Only Google needs anything done to it, and it needs two things. Its schema
 * language is a subset of JSON Schema that has no `additionalProperties`, and it
 * refuses a parameter object with no properties rather than reading it as "this
 * tool takes nothing" - so a no-argument tool is declared with no parameters at
 * all. Both are stated here rather than in the tool definitions, because the
 * definitions are the contract and this is one provider's spelling of it.
 */
function toolSchemaFor(
  dialect: ProviderDialect,
  descriptor: McpToolDescriptor
): Record<string, unknown> | null {
  const schema = descriptor.inputSchema;
  const properties = schema.properties;

  if (dialect !== "google") {
    return {
      type: schema.type,
      properties,
      ...(schema.required === undefined ? {} : { required: schema.required }),
      additionalProperties: schema.additionalProperties
    };
  }

  if (Object.keys(properties).length === 0) return null;

  return {
    type: schema.type,
    properties,
    ...(schema.required === undefined ? {} : { required: schema.required })
  };
}

/**
 * Builds one turn of a conversation.
 *
 * Returns null when the provider has no dialect here or the endpoint will not
 * resolve, so a caller cannot accidentally send something half-formed.
 *
 * With no tools and a single user message this produces exactly what the
 * one-shot path produced before tools existed, which is deliberate: a plain
 * question must not start costing a tool declaration it will never use.
 */
export function buildChatTurn(options: ChatTurnOptions): ChatRequest | null {
  const endpoint = endpointFor(options.provider, options.baseUrl);
  if (endpoint === null) return null;

  const named = options.model.trim();
  const tools = options.tools ?? [];
  const system = (options.system ?? "").trim();
  const dialect = endpoint.dialect;

  if (dialect === "anthropic") {
    return {
      url: endpoint.url,
      dialect,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: named,
        max_tokens: 2048,
        ...temperatureField(dialect, options.temperature),
        ...(system.length === 0 ? {} : { system }),
        ...(tools.length === 0
          ? {}
          : {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: toolSchemaFor(dialect, tool)
              }))
            }),
        messages: anthropicMessages(options.messages)
      })
    };
  }

  if (dialect === "google") {
    const path = googleModelPath(named);
    if (path === null) return null;

    return {
      url: `${endpoint.url}${path}`,
      dialect,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...temperatureField(dialect, options.temperature),
        ...(system.length === 0 ? {} : { systemInstruction: { parts: [{ text: system }] } }),
        ...(tools.length === 0
          ? {}
          : {
              tools: [
                {
                  functionDeclarations: tools.map((tool) => {
                    const parameters = toolSchemaFor(dialect, tool);
                    return {
                      name: tool.name,
                      description: tool.description,
                      ...(parameters === null ? {} : { parameters })
                    };
                  })
                }
              ]
            }),
        contents: googleContents(options.messages)
      })
    };
  }

  const functionTools =
    tools.length === 0
      ? {}
      : {
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: toolSchemaFor(dialect, tool)
            }
          }))
        };

  if (dialect === "ollama") {
    return {
      url: endpoint.url,
      dialect,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: named,
        stream: false,
        ...temperatureField(dialect, options.temperature),
        ...functionTools,
        messages: openAiMessages(options.messages, system, dialect)
      })
    };
  }

  return {
    url: endpoint.url,
    dialect,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: named,
      max_tokens: 2048,
      ...temperatureField(dialect, options.temperature),
      ...functionTools,
      messages: openAiMessages(options.messages, system, dialect)
    })
  };
}

/**
 * The original one-shot entry point.
 *
 * Kept because most of this application asks a question and reads an answer,
 * and that call should not have to know about transcripts to do it.
 */
export function buildChatRequest(
  provider: ProviderId,
  model: string,
  baseUrl: string | null,
  prompt: string,
  temperature: number | null = null
): ChatRequest | null {
  return buildChatTurn({
    provider,
    model,
    baseUrl,
    messages: [{ role: "user", text: prompt.slice(0, MAX_PROMPT_LENGTH) }],
    temperature
  });
}

/**
 * Anthropic's messages.
 *
 * Plain text stays a plain string rather than a one-element block array, which
 * the API accepts either way - so a question with no tools in it produces the
 * same body it always did. Tool results are the only thing that has to be
 * blocks, and they travel in a `user` message because that is where Anthropic
 * expects the answer to a `tool_use` to come from.
 */
function anthropicMessages(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", content: message.text };

    if (message.role === "assistant") {
      const blocks: unknown[] = [];
      if (message.text.length > 0) blocks.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      return { role: "assistant", content: blocks };
    }

    return {
      role: "user",
      content: message.answers.map((answer) => ({
        type: "tool_result",
        tool_use_id: answer.id,
        /*
         * Anthropic is the one dialect that takes an image inside the tool
         * result itself, which is where it belongs: the picture is the answer to
         * the call, not a separate remark made afterwards. The other three need
         * the workaround below.
         */
        content:
          answer.image === null
            ? boundedResult(answer.text)
            : [
                { type: "text", text: boundedResult(answer.text) },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: answer.image.mediaType,
                    data: answer.image.data
                  }
                }
              ],
        is_error: answer.isError
      }))
    };
  });
}

/**
 * The OpenAI shape, which Ollama also speaks.
 *
 * The one difference between them is how a tool call's arguments travel:
 * OpenAI-compatible endpoints send a JSON *string*, Ollama sends an object. It
 * matters on the way back out, because a transcript replayed in the wrong form
 * is a request the provider refuses.
 */
function openAiMessages(
  messages: readonly ChatMessage[],
  system: string,
  dialect: ProviderDialect
): unknown[] {
  const rendered: unknown[] = [];
  if (system.length > 0) rendered.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      rendered.push({ role: "user", content: message.text });
      continue;
    }

    if (message.role === "assistant") {
      rendered.push({
        role: "assistant",
        content: message.text.length > 0 ? message.text : null,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments:
                    dialect === "ollama" ? call.arguments : JSON.stringify(call.arguments)
                }
              }))
            })
      });
      continue;
    }

    for (const answer of message.answers) {
      rendered.push({
        role: "tool",
        tool_call_id: answer.id,
        content: boundedResult(answer.text)
      });

      /*
       * A tool message in this dialect is text and nothing else - the schema has
       * no place to put an image, and sending one there is a request the
       * provider refuses outright. So the picture follows as an ordinary user
       * turn, which is the shape every OpenAI-compatible endpoint does accept.
       * Ollama carries images on the message instead, which is the same idea in
       * that provider's spelling.
       */
      if (answer.image === null) continue;

      rendered.push(
        dialect === "ollama"
          ? {
              role: "user",
              content: `The image from ${answer.name}.`,
              images: [answer.image.data]
            }
          : {
              role: "user",
              content: [
                { type: "text", text: `The image from ${answer.name}.` },
                {
                  type: "image_url",
                  image_url: { url: `data:${answer.image.mediaType};base64,${answer.image.data}` }
                }
              ]
            }
      );
    }
  }

  return rendered;
}

/**
 * Google's contents.
 *
 * Its assistant turn is called `model`, and a tool's answer goes back as a
 * `functionResponse` inside a user turn, matched by name rather than by id -
 * which is why the minted ids are dropped here rather than sent.
 */
function googleContents(messages: readonly ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "user") return { role: "user", parts: [{ text: message.text }] };

    if (message.role === "assistant") {
      const parts: unknown[] = [];
      if (message.text.length > 0) parts.push({ text: message.text });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } });
      }
      return { role: "model", parts };
    }

    /*
     * A `functionResponse` carries a JSON value and has nowhere to put bytes, so
     * an image travels as an `inlineData` part in the same user turn - beside the
     * response rather than inside it, which is as close as this dialect gets.
     */
    const parts: unknown[] = [];
    for (const answer of message.answers) {
      parts.push({
        functionResponse: {
          name: answer.name,
          response: { result: boundedResult(answer.text) }
        }
      });
      if (answer.image !== null) {
        parts.push({ inlineData: { mimeType: answer.image.mediaType, data: answer.image.data } });
      }
    }

    return { role: "user", parts };
  });
}

/* -------------------------------------------------------------------------- */
/* Reading a reply                                                             */
/* -------------------------------------------------------------------------- */

/** Control characters and bidi overrides, which have no place in displayed text. */
const UNSAFE_DISPLAY = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "gu"
);

function replyText(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE_DISPLAY, "").trim();
  return cleaned.length > MAX_REPLY_LENGTH ? cleaned.slice(0, MAX_REPLY_LENGTH) : cleaned;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** How many tool calls one turn may ask for. A model asking for more is confused. */
const MAX_CALLS_PER_TURN = 8;

/** Tool names are compared against a closed set later; this only bounds them. */
function callName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}

/**
 * A call's arguments, whether they arrived as an object or as a JSON string.
 *
 * OpenAI-compatible endpoints send a string and Ollama sends an object, and a
 * model occasionally sends a string where the specification says object. All
 * three are read; anything unreadable becomes an empty bag, which the tool's own
 * validation then rejects with a message the model can act on. That is a better
 * outcome than refusing the whole turn over a comma.
 */
function callArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    try {
      return record(JSON.parse(value) as unknown) ?? {};
    } catch {
      return {};
    }
  }
  return record(value) ?? {};
}

/**
 * Extracts what one turn produced: prose, tool calls, or both.
 *
 * Every step is defensive: the body is a remote host's JSON, so nothing about
 * its shape is assumed. An unreadable reply is `malformed-reply` rather than a
 * crash, and rather than an empty string that would render as a successful but
 * silent answer.
 *
 * A reply carrying tool calls and no prose is a success, not a malformed one.
 * That is the difference between this and the one-shot reader below: asking for
 * a tool *is* the answer to that turn.
 */
export function parseChatOutcome(dialect: ProviderDialect, raw: unknown): ChatOutcome {
  const root = record(raw);
  if (root === null) return { ok: false, code: "malformed-reply" };

  const calls: ToolCall[] = [];
  let minted = 0;
  const mintId = (): string => `call-${++minted}`;

  if (dialect === "anthropic") {
    const content = root["content"];
    if (!Array.isArray(content)) return { ok: false, code: "malformed-reply" };

    const pieces: string[] = [];
    for (const block of content) {
      const entry = record(block);
      if (entry === null) continue;

      if (entry["type"] === "text") {
        const piece = replyText(entry["text"]);
        if (piece.length > 0) pieces.push(piece);
        continue;
      }

      if (entry["type"] === "tool_use" && calls.length < MAX_CALLS_PER_TURN) {
        const name = callName(entry["name"]);
        if (name === null) continue;
        const id = typeof entry["id"] === "string" ? entry["id"] : mintId();
        calls.push({ id, name, arguments: callArguments(entry["input"]) });
      }
    }

    return finishTurn(pieces.join("\n"), calls);
  }

  if (dialect === "google") {
    const candidates = root["candidates"];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { ok: false, code: "malformed-reply" };
    }

    const parts = record(record(candidates[0])?.["content"])?.["parts"];
    if (!Array.isArray(parts)) return { ok: false, code: "malformed-reply" };

    const pieces: string[] = [];
    for (const part of parts) {
      const entry = record(part);
      if (entry === null) continue;

      const piece = replyText(entry["text"]);
      if (piece.length > 0) pieces.push(piece);

      const call = record(entry["functionCall"]);
      if (call !== null && calls.length < MAX_CALLS_PER_TURN) {
        const name = callName(call["name"]);
        // Google matches an answer to a call by name, so the id is this app's
        // own bookkeeping and never leaves it.
        if (name !== null) calls.push({ id: mintId(), name, arguments: callArguments(call["args"]) });
      }
    }

    return finishTurn(pieces.join("\n"), calls);
  }

  const message =
    dialect === "ollama"
      ? record(root["message"])
      : record(record((root["choices"] as unknown[] | undefined)?.[0])?.["message"]);

  if (dialect !== "ollama") {
    const choices = root["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, code: "malformed-reply" };
    }
  }

  if (message === null) return { ok: false, code: "malformed-reply" };

  const rawCalls = message["tool_calls"];
  if (Array.isArray(rawCalls)) {
    for (const entry of rawCalls) {
      if (calls.length >= MAX_CALLS_PER_TURN) break;

      const call = record(entry);
      const fn = record(call?.["function"]);
      const name = callName(fn?.["name"]);
      if (name === null) continue;

      // Ollama assigns no id; OpenAI does, and it must be echoed exactly.
      const id = typeof call?.["id"] === "string" ? (call["id"] as string) : mintId();
      calls.push({ id, name, arguments: callArguments(fn?.["arguments"]) });
    }
  }

  return finishTurn(replyText(message["content"]), calls);
}

function finishTurn(text: string, calls: readonly ToolCall[]): ChatOutcome {
  const bounded = text.slice(0, MAX_REPLY_LENGTH);
  if (bounded.length === 0 && calls.length === 0) {
    return { ok: false, code: "malformed-reply" };
  }
  return { ok: true, reply: { text: bounded, toolCalls: calls } };
}

/**
 * Extracts the assistant's text from a reply.
 *
 * The one-shot reader, for a call that sent no tools and therefore expects
 * prose. A reply that somehow contains only tool calls is `malformed-reply`
 * here, which is the truth for this caller: it asked a question and got no
 * answer to it.
 */
export function parseChatReply(dialect: ProviderDialect, raw: unknown): ProviderResult {
  const outcome = parseChatOutcome(dialect, raw);
  if (!outcome.ok) return outcome;

  return outcome.reply.text.length > 0
    ? { ok: true, text: outcome.reply.text }
    : { ok: false, code: "malformed-reply" };
}

/** Maps an HTTP status onto a code the chrome has wording for. */
export function errorForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "unauthorised";
  if (status === 429) return "rate-limited";
  return "provider-error";
}
