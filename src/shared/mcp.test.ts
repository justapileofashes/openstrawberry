import { describe, expect, it } from "vitest";
import {
  jsonRpcFailure,
  jsonRpcResult,
  MAX_MCP_REQUEST_BYTES,
  MCP_ENDPOINT_PATH,
  MCP_SERVER_NAME,
  negotiateProtocolVersion,
  parseJsonRpcBody,
  parseJsonRpcCall,
  requireToolName,
  SUPPORTED_PROTOCOL_VERSIONS,
  toolArguments,
  toolResultPayload
} from "./mcp.js";
import { IpcValidationError } from "./ipc-validation.js";

describe("protocol identity", () => {
  it("names the server as the tool prefix depends on", () => {
    // A client namespaces tools as `mcp__<server>__<tool>`, and the CLI adapter
    // allowlists that prefix. Changing this string silently un-allows every tool.
    expect(MCP_SERVER_NAME).toBe("openstrawberry");
    expect(MCP_ENDPOINT_PATH).toBe("/mcp");
  });

  it("bounds a request body", () => {
    expect(MAX_MCP_REQUEST_BYTES).toBeGreaterThan(1024);
    expect(MAX_MCP_REQUEST_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe("negotiateProtocolVersion", () => {
  it("agrees to a version the client asked for", () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  it("answers with its own preference for anything else", () => {
    const preferred = SUPPORTED_PROTOCOL_VERSIONS[0];
    expect(negotiateProtocolVersion("1999-01-01")).toBe(preferred);
    expect(negotiateProtocolVersion(undefined)).toBe(preferred);
    expect(negotiateProtocolVersion(7)).toBe(preferred);
    expect(negotiateProtocolVersion({ version: "2025-06-18" })).toBe(preferred);
  });
});

describe("parseJsonRpcCall", () => {
  it("reads a request with an id", () => {
    const call = parseJsonRpcCall({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    expect(call).toEqual({ id: 4, method: "tools/list", params: {} });
  });

  it("reads a string id", () => {
    const call = parseJsonRpcCall({ id: "abc", method: "ping" });
    expect(call?.id).toBe("abc");
  });

  it("treats a message with no id as a notification", () => {
    const call = parseJsonRpcCall({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(call?.id).toBeNull();
  });

  it("refuses anything that is not an object with a method", () => {
    expect(parseJsonRpcCall(null)).toBeNull();
    expect(parseJsonRpcCall("tools/list")).toBeNull();
    expect(parseJsonRpcCall([{ method: "ping" }])).toBeNull();
    expect(parseJsonRpcCall({ method: 7 })).toBeNull();
    expect(parseJsonRpcCall({ method: "" })).toBeNull();
    expect(parseJsonRpcCall({ method: "x".repeat(200) })).toBeNull();
  });

  it("bounds an id rather than accepting any string", () => {
    expect(parseJsonRpcCall({ id: "x".repeat(500), method: "ping" })?.id).toBeNull();
    expect(parseJsonRpcCall({ id: Number.NaN, method: "ping" })?.id).toBeNull();
  });

  it("drops params that are not a plain object rather than refusing the call", () => {
    // Every method here reads named arguments, so an unreadable bag is the same
    // as an empty one and the method's own validation reports it.
    expect(parseJsonRpcCall({ id: 1, method: "tools/call", params: [1, 2] })?.params).toEqual({});
    expect(parseJsonRpcCall({ id: 1, method: "tools/call", params: "x" })?.params).toEqual({});
  });

  it("refuses params carrying a prototype-polluting key", () => {
    const raw = JSON.parse('{"id":1,"method":"tools/call","params":{"__proto__":{"x":1}}}') as unknown;
    expect(parseJsonRpcCall(raw)?.params).toEqual({});
  });
});

describe("parseJsonRpcBody", () => {
  it("reads a single message", () => {
    const body = parseJsonRpcBody({ id: 1, method: "ping" });
    expect(body?.batch).toBe(false);
    expect(body?.calls).toHaveLength(1);
  });

  it("reads a batch", () => {
    const body = parseJsonRpcBody([
      { id: 1, method: "ping" },
      { method: "notifications/initialized" }
    ]);
    expect(body?.batch).toBe(true);
    expect(body?.calls).toHaveLength(2);
  });

  it("refuses an empty batch, an oversized one, and one with a bad member", () => {
    expect(parseJsonRpcBody([])).toBeNull();
    expect(parseJsonRpcBody(Array.from({ length: 65 }, () => ({ id: 1, method: "ping" })))).toBeNull();
    expect(parseJsonRpcBody([{ id: 1, method: "ping" }, { nope: true }])).toBeNull();
  });

  it("refuses a body that is not JSON-RPC at all", () => {
    expect(parseJsonRpcBody(42)).toBeNull();
    expect(parseJsonRpcBody(null)).toBeNull();
  });
});

describe("responses", () => {
  it("shapes a result", () => {
    expect(jsonRpcResult(3, { tools: [] })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { tools: [] }
    });
  });

  it("shapes a failure, including for a message with no id", () => {
    expect(jsonRpcFailure(null, -32700, "Malformed JSON.")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Malformed JSON." }
    });
  });

  it("shapes a tool result as content plus an error flag", () => {
    expect(toolResultPayload({ text: "two tabs", isError: false, image: null })).toEqual({
      content: [{ type: "text", text: "two tabs" }],
      isError: false
    });
  });

  it("carries an image as a second content block, keeping the text", () => {
    expect(
      toolResultPayload({
        text: "A screenshot of https://example.com/",
        isError: false,
        image: { mediaType: "image/png", data: "AAAA" }
      })
    ).toEqual({
      content: [
        { type: "text", text: "A screenshot of https://example.com/" },
        { type: "image", data: "AAAA", mimeType: "image/png" }
      ],
      isError: false
    });
  });
});

describe("tool call parameters", () => {
  it("reads a tool name", () => {
    expect(requireToolName({ name: "list_tabs" })).toBe("list_tabs");
  });

  it("refuses a missing, empty, or oversized name", () => {
    expect(() => requireToolName({})).toThrow(IpcValidationError);
    expect(() => requireToolName({ name: "" })).toThrow(IpcValidationError);
    expect(() => requireToolName({ name: "x".repeat(100) })).toThrow(IpcValidationError);
    expect(() => requireToolName({ name: 7 })).toThrow(IpcValidationError);
  });

  it("treats absent arguments as an empty bag", () => {
    expect(toolArguments({})).toEqual({});
    expect(toolArguments({ arguments: null })).toEqual({});
  });

  it("refuses arguments that are not a plain object", () => {
    expect(() => toolArguments({ arguments: ["tab-1"] })).toThrow(IpcValidationError);
  });

  it("never echoes a rejected value in its message", () => {
    // The same rule the IPC validators hold: an error string is the easiest
    // place for content to travel somewhere it was not meant to go.
    try {
      requireToolName({ name: "secret-value-do-not-echo".repeat(10) });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value-do-not-echo");
    }
  });
});
