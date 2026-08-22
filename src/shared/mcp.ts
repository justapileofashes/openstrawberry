/**
 * The Model Context Protocol, as much of it as OpenStrawberry speaks.
 *
 * This is JSON-RPC 2.0 over one HTTP endpoint - the protocol's "streamable
 * HTTP" transport - reduced to the four methods a tool server actually needs:
 * `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
 * Nothing here opens a stream, offers a resource, samples a model, or keeps a
 * protocol session, because this server does none of those things.
 *
 * It is written by hand rather than taken from the reference SDK, and that is a
 * deliberate trade. The SDK arrives with an HTTP framework, a CORS layer, a
 * rate limiter, a schema validator, and an OAuth client - every one of which
 * would be packaged into the asar, and every one of which is surface on a socket
 * that this application binds to the loopback interface precisely so that it has
 * as little surface as possible. What is actually spoken on the wire is small
 * enough to read in one sitting, so it is written out where it can be read.
 *
 * The shapes below were checked against a real client rather than against the
 * specification alone: Claude Code 2.1.227 opens with an unrecognised
 * `server/discover` probe, falls back cleanly when it is refused, then runs
 * `initialize` -> `notifications/initialized` -> a `GET` it accepts a refusal on
 * -> `tools/list` -> `tools/call`. Every one of those paths is handled here.
 */
import { requirePlainObject, requireString } from "./ipc-validation.js";

/**
 * The name this server is mounted under.
 *
 * It is part of the contract rather than a label: a client namespaces every tool
 * it loads as `mcp__<server>__<tool>`, so this string is what an allowlist on the
 * command line has to name, and changing it silently un-allows every tool.
 */
export const MCP_SERVER_NAME = "openstrawberry";

/** The path the endpoint is served at. One endpoint; the transport needs no more. */
export const MCP_ENDPOINT_PATH = "/mcp";

/**
 * Protocol revisions this server will answer as.
 *
 * Newest first. They are listed together because the surface this server
 * exposes - tools, and only tools - is identical in all three, so agreeing to an
 * older one costs nothing and refusing it would strand a client for no reason.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26"
];

/**
 * The version to answer `initialize` with.
 *
 * Echoing the client's own choice when it is one this server speaks is what the
 * protocol asks for; anything else gets this server's preferred version, and the
 * client decides whether it can live with that.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  const preferred = SUPPORTED_PROTOCOL_VERSIONS[0] as string;
  if (typeof requested !== "string") return preferred;
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : preferred;
}

/**
 * How much of a request body will be read.
 *
 * A tool call carries a handful of short arguments, so this is already
 * enormously generous. It exists because the body arrives from a socket and the
 * only alternative to a cap is an unbounded allocation in the trusted process.
 */
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;

/** JSON-RPC's own error codes, used with their standard meanings. */
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/** JSON-RPC allows a string or a number. A notification carries neither. */
export type JsonRpcId = string | number;

/**
 * One inbound message.
 *
 * `id` is null for a notification, which is the protocol's way of saying "no
 * reply is expected" - and the reason `notifications/initialized` gets an empty
 * `202` rather than a response body.
 */
export interface JsonRpcCall {
  readonly id: JsonRpcId | null;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: { readonly code: number; readonly message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/**
 * A failure reply.
 *
 * The message is always one this module or its caller holds. Nothing a client
 * sent is echoed back, for the same reason the IPC validators never echo a
 * rejected value: an error string is the easiest place for content to travel
 * somewhere it was not meant to go.
 */
export function jsonRpcFailure(
  id: JsonRpcId | null,
  code: number,
  message: string
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Reads one message, or nothing.
 *
 * Deliberately tolerant about the envelope and strict about the parts that are
 * acted on: a missing `jsonrpc` field is ignored, because refusing a client over
 * a version tag it forgot helps nobody, while a method that is not a string is
 * refused outright, because that is the value the dispatcher switches on.
 */
export function parseJsonRpcCall(raw: unknown): JsonRpcCall | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const message = raw as Record<string, unknown>;
  const method = message["method"];
  if (typeof method !== "string" || method.length === 0 || method.length > 128) {
    return null;
  }

  const id = message["id"];
  const identifier =
    typeof id === "string" && id.length > 0 && id.length <= 256
      ? id
      : typeof id === "number" && Number.isFinite(id)
        ? id
        : null;

  const rawParams = message["params"];
  let params: Record<string, unknown> = {};
  if (rawParams !== undefined && rawParams !== null) {
    try {
      params = requirePlainObject(rawParams, "Request parameters");
    } catch {
      // Params that are not an object are dropped rather than refused: every
      // method here reads named arguments, so an unreadable bag is the same
      // thing as an empty one and the method's own validation reports it.
      params = {};
    }
  }

  return { id: identifier, method, params };
}

/**
 * Reads a whole request body, which may be one message or a batch of them.
 *
 * Returns null for anything that is not JSON-RPC at all, so the caller can
 * answer with a parse error rather than guess.
 */
export function parseJsonRpcBody(
  raw: unknown
): { readonly batch: boolean; readonly calls: readonly JsonRpcCall[] } | null {
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.length > 64) return null;

    const calls: JsonRpcCall[] = [];
    for (const entry of raw) {
      const call = parseJsonRpcCall(entry);
      if (call === null) return null;
      calls.push(call);
    }
    return { batch: true, calls };
  }

  const single = parseJsonRpcCall(raw);
  return single === null ? null : { batch: false, calls: [single] };
}

/* ------------------------------------------------------------------------- */
/* Tools                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * A JSON Schema for one tool's arguments.
 *
 * Typed loosely on purpose. This value is serialised straight into a
 * `tools/list` reply and is never used to validate anything - the arguments that
 * come back are re-derived by hand, because a schema a client was *told* about
 * proves nothing about what it then sends.
 */
export interface McpToolSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpToolSchema;
}

/** An image a tool produced, already encoded and bounded by whoever made it. */
export interface McpToolImage {
  readonly mediaType: "image/png" | "image/jpeg";
  /** Base64, with no data-URI prefix; each transport adds what it needs. */
  readonly data: string;
}

/**
 * What a tool hands back: text, whether that text is a failure, and optionally
 * one image.
 *
 * Text is always present even when there is an image, because a client that
 * cannot render one still has to be told what it was looking at, and because
 * the text is where the untrusted-content marker lives.
 */
export interface McpToolResult {
  readonly text: string;
  readonly isError: boolean;
  readonly image: McpToolImage | null;
}

/**
 * The wire shape of a tool result.
 *
 * An image travels as a second content block, which is what the protocol
 * already defines for one - no extension, and a client that ignores unknown
 * block types still gets the text.
 */
export function toolResultPayload(result: McpToolResult): Record<string, unknown> {
  const content: Record<string, unknown>[] = [{ type: "text", text: result.text }];

  if (result.image !== null) {
    content.push({
      type: "image",
      data: result.image.data,
      mimeType: result.image.mediaType
    });
  }

  return { content, isError: result.isError };
}

/**
 * The tool name out of a `tools/call` request.
 *
 * Throws `IpcValidationError` for anything unusable, which the dispatcher turns
 * into an invalid-params reply. The same validators the IPC boundary uses, for
 * the same reason: this is another untrusted process sending JSON.
 */
export function requireToolName(params: Record<string, unknown>): string {
  return requireString(params["name"], "Tool name", 64);
}

/** The argument bag out of a `tools/call` request. Absent means empty. */
export function toolArguments(params: Record<string, unknown>): Record<string, unknown> {
  const raw = params["arguments"];
  if (raw === undefined || raw === null) return {};
  return requirePlainObject(raw, "Tool arguments");
}
