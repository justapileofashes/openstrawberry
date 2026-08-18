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

/** Bounds a reply. Generous for prose, far short of anything pathological. */
export const MAX_REPLY_LENGTH = 16_000;

/** Bounds the prompt sent. The task is already capped well below this. */
export const MAX_PROMPT_LENGTH = 8_000;

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
  "cancelled"
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERRORS)[number];

export type ProviderResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: ProviderErrorCode };

/**
 * The wire dialects this app speaks.
 *
 * Two, not nine. Most hosted providers expose an OpenAI-compatible chat
 * endpoint, and Anthropic has its own; adding a provider is usually adding a row
 * to the table below rather than a third dialect.
 */
export type ProviderDialect = "anthropic" | "openai" | "ollama";

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

/**
 * Builds a request.
 *
 * Returns null when the provider has no dialect here or the endpoint will not
 * resolve, so a caller cannot accidentally send something half-formed.
 */
export function buildChatRequest(
  provider: ProviderId,
  model: string,
  baseUrl: string | null,
  prompt: string
): ChatRequest | null {
  const endpoint = endpointFor(provider, baseUrl);
  if (endpoint === null) return null;

  const bounded = prompt.slice(0, MAX_PROMPT_LENGTH);
  const named = model.trim();

  if (endpoint.dialect === "anthropic") {
    return {
      url: endpoint.url,
      dialect: endpoint.dialect,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: named,
        max_tokens: 2048,
        messages: [{ role: "user", content: bounded }]
      })
    };
  }

  if (endpoint.dialect === "ollama") {
    return {
      url: endpoint.url,
      dialect: endpoint.dialect,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: named,
        stream: false,
        messages: [{ role: "user", content: bounded }]
      })
    };
  }

  return {
    url: endpoint.url,
    dialect: endpoint.dialect,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: named,
      max_tokens: 2048,
      messages: [{ role: "user", content: bounded }]
    })
  };
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

/**
 * Extracts the assistant's text from a reply.
 *
 * Every step is defensive: the body is a remote host's JSON, so nothing about
 * its shape is assumed. An unreadable reply is `malformed-reply` rather than a
 * crash, and rather than an empty string that would render as a successful but
 * silent answer.
 */
export function parseChatReply(dialect: ProviderDialect, raw: unknown): ProviderResult {
  const root = record(raw);
  if (root === null) return { ok: false, code: "malformed-reply" };

  if (dialect === "anthropic") {
    const content = root["content"];
    if (!Array.isArray(content)) return { ok: false, code: "malformed-reply" };

    // Concatenated, because a reply can arrive as several text blocks.
    const text = content
      .map((block) => {
        const entry = record(block);
        return entry?.["type"] === "text" ? replyText(entry["text"]) : "";
      })
      .filter((part) => part.length > 0)
      .join("\n");

    return text.length > 0
      ? { ok: true, text: text.slice(0, MAX_REPLY_LENGTH) }
      : { ok: false, code: "malformed-reply" };
  }

  if (dialect === "ollama") {
    const message = record(root["message"]);
    const text = replyText(message?.["content"]);
    return text.length > 0 ? { ok: true, text } : { ok: false, code: "malformed-reply" };
  }

  const choices = root["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, code: "malformed-reply" };
  }

  const message = record(record(choices[0])?.["message"]);
  const text = replyText(message?.["content"]);

  return text.length > 0 ? { ok: true, text } : { ok: false, code: "malformed-reply" };
}

/** Maps an HTTP status onto a code the chrome has wording for. */
export function errorForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return "unauthorised";
  if (status === 429) return "rate-limited";
  return "provider-error";
}
