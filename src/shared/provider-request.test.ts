/**
 * Speaking four dialects of the same conversation.
 *
 * The neutral transcript is the point of this module, and the risk in it is
 * that a dialect is rendered nearly right: a tool call replayed as a string
 * where the provider wanted an object, or an answer matched by an id the
 * provider never issued, is a request that is refused after the browser work
 * was already done. So every dialect is rendered and parsed here, and the two
 * are checked against each other.
 */
import { describe, expect, it } from "vitest";
import {
  buildChatRequest,
  buildChatTurn,
  MAX_TOOL_RESULT_LENGTH,
  MAX_TOOL_TURNS,
  parseChatOutcome,
  parseChatReply,
  transcriptSize,
  type ChatMessage,
  IMAGE_TRANSCRIPT_COST,
  type ProviderDialect
} from "./provider-request.js";
import type { McpToolDescriptor } from "./mcp.js";
import type { ProviderId } from "./agents.js";

const TOOLS: readonly McpToolDescriptor[] = [
  {
    name: "list_tabs",
    description: "List the tabs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "read_page",
    description: "Read a page.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "string" } },
      required: ["tabId"],
      additionalProperties: false
    }
  }
];

/** provider -> the dialect it speaks, for the table-driven cases below. */
const PROVIDERS: readonly (readonly [ProviderId, ProviderDialect])[] = [
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["google", "google"],
  ["ollama", "ollama"]
];

function bodyOf(provider: ProviderId, messages: readonly ChatMessage[], withTools = true): Record<string, unknown> {
  const request = buildChatTurn({
    provider,
    model: "a-model",
    baseUrl: null,
    messages,
    ...(withTools ? { tools: TOOLS } : {}),
    system: "You can drive the browser."
  });
  if (request === null) throw new Error(`no request for ${provider}`);
  return JSON.parse(request.body) as Record<string, unknown>;
}

const CONVERSATION: readonly ChatMessage[] = [
  { role: "user", text: "What is open?" },
  {
    role: "assistant",
    text: "Let me look.",
    toolCalls: [{ id: "call_abc", name: "read_page", arguments: { tabId: "tab-1" } }]
  },
  {
    role: "tool",
    answers: [
      { id: "call_abc", name: "read_page", text: "A page about kelp.", isError: false, image: null }
    ]
  }
];

describe("the plain path is unchanged", () => {
  it("sends no tool declarations when none were given", () => {
    for (const [provider] of PROVIDERS) {
      const body = bodyOf(provider, [{ role: "user", text: "hello" }], false);
      expect(body["tools"], provider).toBeUndefined();
    }
  });

  it("still builds the one-shot request the rest of the app makes", () => {
    const request = buildChatRequest("anthropic", "claude-opus-5", null, "hello");
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");

    const body = JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
    expect(body["messages"]).toEqual([{ role: "user", content: "hello" }]);
    expect(body["tools"]).toBeUndefined();
    expect(body["system"]).toBeUndefined();
  });

  it("bounds the prompt it was given", () => {
    const request = buildChatRequest("openai", "gpt", null, "x".repeat(50_000));
    const body = JSON.parse(request?.body ?? "{}") as { messages: { content: string }[] };
    expect(body.messages[0]?.content.length).toBeLessThanOrEqual(8000);
  });
});

describe("declaring tools", () => {
  it("uses each provider's own spelling", () => {
    const anthropic = bodyOf("anthropic", [{ role: "user", text: "hi" }]);
    expect((anthropic["tools"] as { name: string; input_schema: unknown }[])[0]?.name).toBe(
      "list_tabs"
    );
    expect((anthropic["tools"] as { input_schema: unknown }[])[0]?.input_schema).toBeDefined();

    const openai = bodyOf("openai", [{ role: "user", text: "hi" }]);
    expect((openai["tools"] as { type: string }[])[0]?.type).toBe("function");
    expect(
      (openai["tools"] as { function: { name: string; parameters: unknown } }[])[0]?.function.name
    ).toBe("list_tabs");

    const google = bodyOf("google", [{ role: "user", text: "hi" }]);
    const declarations = (google["tools"] as { functionDeclarations: { name: string }[] }[])[0];
    expect(declarations?.functionDeclarations.map((entry) => entry.name)).toEqual([
      "list_tabs",
      "read_page"
    ]);

    const ollama = bodyOf("ollama", [{ role: "user", text: "hi" }]);
    expect((ollama["tools"] as { type: string }[])[0]?.type).toBe("function");
  });

  it("omits parameters entirely for a no-argument tool on Google", () => {
    // Gemini refuses a parameter object with no properties rather than reading
    // it as "this tool takes nothing".
    const google = bodyOf("google", [{ role: "user", text: "hi" }]);
    const declarations = (
      google["tools"] as { functionDeclarations: Record<string, unknown>[] }[]
    )[0]?.functionDeclarations;

    expect(declarations?.[0]?.["parameters"]).toBeUndefined();
    expect(declarations?.[1]?.["parameters"]).toBeDefined();
  });

  it("drops additionalProperties for Google, whose schema language has none", () => {
    const google = bodyOf("google", [{ role: "user", text: "hi" }]);
    expect(JSON.stringify(google["tools"])).not.toContain("additionalProperties");

    // Everywhere else it is kept, because closing the schema is the point of it.
    expect(JSON.stringify(bodyOf("openai", [{ role: "user", text: "hi" }])["tools"])).toContain(
      "additionalProperties"
    );
  });

  it("puts the system instruction where each provider looks for it", () => {
    expect(bodyOf("anthropic", [{ role: "user", text: "hi" }])["system"]).toContain("browser");

    const google = bodyOf("google", [{ role: "user", text: "hi" }]);
    expect(JSON.stringify(google["systemInstruction"])).toContain("browser");

    const openai = bodyOf("openai", [{ role: "user", text: "hi" }]);
    expect((openai["messages"] as { role: string }[])[0]?.role).toBe("system");
  });
});

describe("replaying a transcript", () => {
  it("renders Anthropic's tool_use and tool_result blocks", () => {
    const body = bodyOf("anthropic", CONVERSATION);
    const messages = body["messages"] as { role: string; content: unknown }[];

    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toEqual([
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "call_abc", name: "read_page", input: { tabId: "tab-1" } }
    ]);

    // The answer to a tool_use comes back as a user message. That is where
    // Anthropic expects it, not in an assistant one.
    expect(messages[2]?.role).toBe("user");
    expect(messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call_abc",
        content: "A page about kelp.",
        is_error: false
      }
    ]);
  });

  it("renders OpenAI's tool_calls with arguments as a JSON string", () => {
    const body = bodyOf("openai", CONVERSATION);
    const messages = body["messages"] as Record<string, unknown>[];
    const assistant = messages.find((entry) => entry["role"] === "assistant");
    const call = (assistant?.["tool_calls"] as { function: { arguments: unknown } }[])[0];

    expect(typeof call?.function.arguments).toBe("string");
    expect(JSON.parse(call?.function.arguments as string)).toEqual({ tabId: "tab-1" });

    const answer = messages.find((entry) => entry["role"] === "tool");
    expect(answer?.["tool_call_id"]).toBe("call_abc");
    expect(answer?.["content"]).toBe("A page about kelp.");
  });

  it("renders Ollama's tool_calls with arguments as an object", () => {
    // The one difference from the OpenAI shape, and a transcript replayed in
    // the wrong form is a request the provider refuses.
    const body = bodyOf("ollama", CONVERSATION);
    const messages = body["messages"] as Record<string, unknown>[];
    const assistant = messages.find((entry) => entry["role"] === "assistant");
    const call = (assistant?.["tool_calls"] as { function: { arguments: unknown } }[])[0];

    expect(call?.function.arguments).toEqual({ tabId: "tab-1" });
  });

  it("renders Google's model turn and matches an answer by name", () => {
    const body = bodyOf("google", CONVERSATION);
    const contents = body["contents"] as { role: string; parts: Record<string, unknown>[] }[];

    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts[1]).toEqual({
      functionCall: { name: "read_page", args: { tabId: "tab-1" } }
    });

    expect(contents[2]?.role).toBe("user");
    expect(contents[2]?.parts[0]).toEqual({
      functionResponse: { name: "read_page", response: { result: "A page about kelp." } }
    });

    // Google issues no call ids, so this app's own must not be sent.
    expect(JSON.stringify(body)).not.toContain("call_abc");
  });

  it("bounds a tool result on the way out, in every dialect", () => {
    const huge: readonly ChatMessage[] = [
      { role: "user", text: "read it" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "read_page", arguments: {} }]
      },
      {
        role: "tool",
        answers: [
          { id: "c1", name: "read_page", text: "y".repeat(90_000), isError: false, image: null }
        ]
      }
    ];

    for (const [provider] of PROVIDERS) {
      const serialised = JSON.stringify(bodyOf(provider, huge));
      expect(serialised.length, provider).toBeLessThan(MAX_TOOL_RESULT_LENGTH + 6000);
    }
  });
});

describe("parsing a reply", () => {
  it("reads Anthropic's tool_use blocks", () => {
    const outcome = parseChatOutcome("anthropic", {
      content: [
        { type: "text", text: "Looking now." },
        { type: "tool_use", id: "toolu_1", name: "read_page", input: { tabId: "tab-1" } }
      ]
    });

    expect(outcome.ok && outcome.reply.text).toBe("Looking now.");
    expect(outcome.ok && outcome.reply.toolCalls).toEqual([
      { id: "toolu_1", name: "read_page", arguments: { tabId: "tab-1" } }
    ]);
  });

  it("reads OpenAI's tool_calls, decoding the argument string", () => {
    const outcome = parseChatOutcome("openai", {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "open_tab", arguments: '{"url":"https://a.test/"}' }
              }
            ]
          }
        }
      ]
    });

    expect(outcome.ok && outcome.reply.toolCalls[0]).toEqual({
      id: "call_1",
      name: "open_tab",
      arguments: { url: "https://a.test/" }
    });
  });

  it("reads Ollama's tool_calls and mints the id it does not send", () => {
    const outcome = parseChatOutcome("ollama", {
      message: {
        content: "",
        tool_calls: [{ function: { name: "list_tabs", arguments: {} } }]
      }
    });

    expect(outcome.ok && outcome.reply.toolCalls[0]?.name).toBe("list_tabs");
    expect(outcome.ok && outcome.reply.toolCalls[0]?.id.length).toBeGreaterThan(0);
  });

  it("reads Google's functionCall parts", () => {
    const outcome = parseChatOutcome("google", {
      candidates: [
        {
          content: {
            parts: [{ text: "One moment." }, { functionCall: { name: "list_tabs", args: {} } }]
          }
        }
      ]
    });

    expect(outcome.ok && outcome.reply.text).toBe("One moment.");
    expect(outcome.ok && outcome.reply.toolCalls[0]?.name).toBe("list_tabs");
  });

  it("treats a turn with tool calls and no prose as a success", () => {
    // Asking for a tool is the answer to that turn.
    const outcome = parseChatOutcome("anthropic", {
      content: [{ type: "tool_use", id: "t1", name: "list_tabs", input: {} }]
    });
    expect(outcome.ok).toBe(true);
  });

  it("still reports an empty reply as malformed", () => {
    for (const [, dialect] of PROVIDERS) {
      expect(parseChatOutcome(dialect, {}).ok, dialect).toBe(false);
    }
    expect(parseChatOutcome("anthropic", { content: [] }).ok).toBe(false);
  });

  it("survives a provider inventing shapes", () => {
    expect(parseChatOutcome("anthropic", { content: [null, 7, { type: "tool_use" }] }).ok).toBe(
      false
    );
    expect(
      parseChatOutcome("openai", { choices: [{ message: { content: "hi", tool_calls: "nope" } }] })
        .ok
    ).toBe(true);
    expect(parseChatOutcome("google", { candidates: [] }).ok).toBe(false);
    expect(parseChatOutcome("ollama", "a string").ok).toBe(false);
  });

  it("reads an unparseable argument string as an empty bag", () => {
    // The tool's own validation then reports which argument is missing, which
    // is something the model can act on. Refusing the turn is not.
    const outcome = parseChatOutcome("openai", {
      choices: [
        {
          message: {
            tool_calls: [{ id: "c", function: { name: "read_page", arguments: "{not json" } }]
          }
        }
      ]
    });

    expect(outcome.ok && outcome.reply.toolCalls[0]?.arguments).toEqual({});
  });

  it("caps how many calls one turn may ask for", () => {
    const outcome = parseChatOutcome("anthropic", {
      content: Array.from({ length: 40 }, (_, index) => ({
        type: "tool_use",
        id: `t${index}`,
        name: "list_tabs",
        input: {}
      }))
    });

    expect(outcome.ok && outcome.reply.toolCalls.length).toBeLessThanOrEqual(8);
  });

  it("keeps the one-shot reader's meaning: tool calls alone are no answer", () => {
    const raw = { content: [{ type: "tool_use", id: "t1", name: "list_tabs", input: {} }] };
    expect(parseChatOutcome("anthropic", raw).ok).toBe(true);
    expect(parseChatReply("anthropic", raw)).toEqual({ ok: false, code: "malformed-reply" });
  });
});

describe("bounds", () => {
  it("measures a transcript", () => {
    expect(transcriptSize([{ role: "user", text: "12345" }])).toBe(5);
    expect(transcriptSize(CONVERSATION)).toBeGreaterThan(20);
  });

  it("counts an image against the transcript, not just its text", () => {
    /*
     * A screenshot is a handful of characters of base64 in this shape and a
     * large fraction of a context window at the provider. Counting only the text
     * would let a loop take pictures until the request itself was refused.
     */
    const withImage: readonly ChatMessage[] = [
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "screenshot", arguments: {} }] },
      {
        role: "tool",
        answers: [
          {
            id: "c1",
            name: "screenshot",
            text: "shot",
            isError: false,
            image: { mediaType: "image/png", data: "AAAA" }
          }
        ]
      }
    ];

    expect(transcriptSize(withImage)).toBeGreaterThan(IMAGE_TRANSCRIPT_COST);
  });

  it("caps the turns a loop may take", () => {
    /*
     * The ceiling rose with the tools. A loop that only read could finish in a
     * handful of turns; one that also acts spends them in fours — snapshot, act,
     * read the diff, snapshot again — so a single form is most of a dozen before
     * the task proper begins. Still a cap, and still small enough that a runaway
     * loop is bounded rather than merely discouraged.
     */
    expect(MAX_TOOL_TURNS).toBeGreaterThan(2);
    expect(MAX_TOOL_TURNS).toBeLessThanOrEqual(32);
  });
});

describe("an image in a tool result", () => {
  const SHOT: readonly ChatMessage[] = [
    { role: "user", text: "What does it look like?" },
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "c1", name: "screenshot", arguments: { tabId: "tab-1" } }]
    },
    {
      role: "tool",
      answers: [
        {
          id: "c1",
          name: "screenshot",
          text: "A screenshot of https://example.com/",
          isError: false,
          image: { mediaType: "image/png", data: "SGVsbG8=" }
        }
      ]
    }
  ];

  it("reaches every dialect, whatever each one calls the field", () => {
    // The point of the neutral transcript: one answer, four spellings, and the
    // loop that produced it never learns which provider it is talking to.
    for (const [provider] of PROVIDERS) {
      expect(JSON.stringify(bodyOf(provider, SHOT)), provider).toContain("SGVsbG8=");
    }
  });

  it("puts it inside the tool result for Anthropic, where it belongs", () => {
    const messages = bodyOf("anthropic", SHOT)["messages"] as readonly Record<string, unknown>[];
    const result = messages.at(-1);
    const blocks = (result?.["content"] as readonly Record<string, unknown>[])[0]?.[
      "content"
    ] as readonly Record<string, unknown>[];

    expect(blocks[0]).toEqual({ type: "text", text: "A screenshot of https://example.com/" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "SGVsbG8=" }
    });
  });

  it("follows the tool message with a user turn where the schema has no room", () => {
    /*
     * An OpenAI tool message is text and nothing else, and sending an image
     * there is a request the provider refuses outright. The picture therefore
     * arrives as the next user turn, which every compatible endpoint accepts.
     */
    const messages = bodyOf("openai", SHOT)["messages"] as readonly Record<string, unknown>[];
    const toolIndex = messages.findIndex((entry) => entry["role"] === "tool");
    const follower = messages[toolIndex + 1];

    expect(follower?.["role"]).toBe("user");
    expect(JSON.stringify(follower)).toContain("data:image/png;base64,SGVsbG8=");
  });

  it("uses Ollama's own images field rather than a data URI", () => {
    const messages = bodyOf("ollama", SHOT)["messages"] as readonly Record<string, unknown>[];
    const follower = messages.find((entry) => Array.isArray(entry["images"]));

    expect(follower?.["images"]).toEqual(["SGVsbG8="]);
    expect(JSON.stringify(follower)).not.toContain("data:image");
  });

  it("puts it beside the functionResponse for Google, which has nowhere inside", () => {
    const contents = bodyOf("google", SHOT)["contents"] as readonly Record<string, unknown>[];
    const parts = contents.at(-1)?.["parts"] as readonly Record<string, unknown>[];

    expect(parts[0]).toHaveProperty("functionResponse");
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "SGVsbG8=" } });
  });

  it("changes nothing at all for an answer with no image", () => {
    // The overwhelmingly common case. A screenshot must not reshape the bodies
    // every other tool result travels in.
    for (const [provider] of PROVIDERS) {
      expect(JSON.stringify(bodyOf(provider, CONVERSATION)), provider).not.toContain("image");
    }
  });
});

describe("temperature", () => {
  const ask: readonly ChatMessage[] = [{ role: "user", text: "Hello" }];

  const bodyFor = (provider: ProviderId, temperature: number | null): Record<string, unknown> => {
    const request = buildChatTurn({
      provider,
      model: provider === "google" ? "gemini-2.5-pro" : "a-model",
      baseUrl: null,
      messages: ask,
      temperature
    });

    if (request === null) throw new Error("no request built");
    return JSON.parse(request.body) as Record<string, unknown>;
  };

  it("sends nothing at all when none is configured", () => {
    /*
     * Null and 0 are different requests. Leaving the field out takes whatever
     * the provider defaults to; sending 0 asks for greedy decoding. An empty box
     * in the form means the first, so the body must not carry the second.
     */
    for (const provider of ["anthropic", "openai", "google", "ollama"] as const) {
      const body = bodyFor(provider, null);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("generationConfig");
      expect(body).not.toHaveProperty("options");
    }
  });

  it("spells the field the way each dialect wants it", () => {
    expect(bodyFor("anthropic", 0.2)["temperature"]).toBe(0.2);
    expect(bodyFor("openai", 0.2)["temperature"]).toBe(0.2);
    expect(bodyFor("google", 0.2)["generationConfig"]).toEqual({ temperature: 0.2 });
    expect(bodyFor("ollama", 0.2)["options"]).toEqual({ temperature: 0.2 });
  });

  it("sends a zero rather than reading it as nothing", () => {
    expect(bodyFor("openai", 0)["temperature"]).toBe(0);
    expect(bodyFor("google", 0)["generationConfig"]).toEqual({ temperature: 0 });
  });

  it("leaves the rest of the body exactly as it was", () => {
    // A route with no temperature must produce byte-for-byte what it produced
    // before this setting existed, or the feature has changed a working call.
    const before = buildChatRequest("anthropic", "a-model", null, "Hello");
    const after = buildChatTurn({
      provider: "anthropic",
      model: "a-model",
      baseUrl: null,
      messages: ask
    });

    expect(after?.body).toBe(before?.body);
  });

  it("ignores a value that is not a finite number", () => {
    expect(bodyFor("openai", Number.NaN)).not.toHaveProperty("temperature");
  });
});
