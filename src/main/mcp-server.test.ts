/**
 * The socket, tested as a socket.
 *
 * Everything here goes over a real loopback connection rather than through a
 * handler called directly, because the properties that matter are properties of
 * what is reachable on a port: that a caller with no token gets nothing, that a
 * browser cannot speak to it at all, that a revoked session is revoked, and that
 * nothing is listening when no run is live. None of those can be proved by
 * invoking a function.
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserMcpServer, type BrowserSession } from "./mcp-server.js";
import type { BrowserToolPort } from "./browser-tools.js";
import { MCP_SERVER_NAME } from "../shared/mcp.js";
import type { BrowserSnapshot, BrowserTabState } from "../shared/browser.js";

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    id: "tab-1",
    url: "https://example.com/",
    title: "Example",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    isAudible: false,
    paneId: "primary",
    groupId: null,
    ...overrides
  };
}

let tabs: BrowserTabState[] = [];

function snapshot(): BrowserSnapshot {
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

const closed: string[] = [];

const browser: BrowserToolPort = {
  snapshot,
  createTab: (paneId, url) => {
    tabs = [...tabs, tab({ id: "tab-9", url, title: url, paneId })];
    return snapshot();
  },
  closeTab: (tabId) => {
    closed.push(tabId);
    tabs = tabs.filter((entry) => entry.id !== tabId);
    return snapshot();
  },
  navigate: () => snapshot(),
  goBack: () => snapshot(),
  goForward: () => snapshot(),
  reload: () => snapshot(),
  contentsFor: () => null
};

let directory = "";
let server: BrowserMcpServer;
let approve: ReturnType<typeof vi.fn>;

interface Endpoint {
  readonly url: string;
  readonly token: string;
}

function endpointFrom(session: BrowserSession): Endpoint {
  const config = JSON.parse(readFileSync(session.configPath, "utf8")) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  };
  const entry = config.mcpServers[MCP_SERVER_NAME];
  if (entry === undefined) throw new Error("no server entry");
  return { url: entry.url, token: entry.headers["Authorization"]?.slice("Bearer ".length) ?? "" };
}

async function call(
  endpoint: Endpoint,
  body: unknown,
  init: { token?: string | null; headers?: Record<string, string>; method?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const token = init.token === undefined ? endpoint.token : init.token;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...init.headers
  };

  const response = await fetch(endpoint.url, {
    method: init.method ?? "POST",
    headers,
    ...(init.method === "GET" ? {} : { body: JSON.stringify(body) })
  });

  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? null : (JSON.parse(text) as unknown) };
}

/** A raw request, so a header `fetch` will not let us forge can be sent. */
function rawRequest(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json", ...headers }
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
}

function openSession(tabIds: readonly string[] = ["tab-1"]): Promise<BrowserSession | null> {
  return server.open({
    agentName: "Scout",
    tabIds,
    approve: approve as unknown as (
      toolName: string,
      summary: string,
      reason: string,
      tabId: string | null
    ) => Promise<boolean>
  });
}

async function handshake(endpoint: Endpoint): Promise<void> {
  await call(endpoint, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await call(endpoint, { jsonrpc: "2.0", method: "notifications/initialized" });
}

function resultOf(body: unknown): Record<string, unknown> {
  return (body as { result: Record<string, unknown> }).result;
}

function toolText(body: unknown): string {
  const content = resultOf(body)["content"] as { text: string }[];
  return content[0]?.text ?? "";
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-mcp-"));
  tabs = [tab(), tab({ id: "tab-2", url: "https://private.test/", title: "Private" })];
  closed.length = 0;
  approve = vi.fn(() => Promise.resolve(true));
  server = new BrowserMcpServer({
    browser,
    configDir: directory,
    toolOptions: { sleep: () => Promise.resolve(), settleTimeoutMs: 0 }
  });
});

afterEach(() => {
  server.destroy();
});

describe("the session config", () => {
  it("writes a loopback endpoint and a bearer token", async () => {
    const session = await openSession();
    expect(session).not.toBeNull();

    const endpoint = endpointFrom(session as BrowserSession);
    expect(endpoint.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(endpoint.url.endsWith("/mcp")).toBe(true);
    expect(endpoint.token.length).toBeGreaterThan(30);
  });

  it("removes the file when the session closes", async () => {
    const session = (await openSession()) as BrowserSession;
    expect(existsSync(session.configPath)).toBe(true);

    session.close();
    expect(existsSync(session.configPath)).toBe(false);
  });

  it("gives two runs different tokens", async () => {
    const first = endpointFrom((await openSession()) as BrowserSession);
    const second = endpointFrom((await openSession()) as BrowserSession);

    expect(first.token).not.toBe(second.token);
    expect(first.url).toBe(second.url);
  });
});

describe("authentication", () => {
  it("refuses a caller with no token", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await call(endpoint, { id: 1, method: "tools/list" }, { token: null });
    expect(response.status).toBe(401);
  });

  it("refuses a caller with the wrong token", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await call(endpoint, { id: 1, method: "tools/list" }, { token: "not-it" });
    expect(response.status).toBe(401);
  });

  it("refuses a token that belonged to a closed session", async () => {
    const session = (await openSession()) as BrowserSession;
    const endpoint = endpointFrom(session);

    // A second session keeps the listener alive so this tests revocation rather
    // than the socket simply having gone.
    await openSession();

    expect((await call(endpoint, { id: 1, method: "tools/list" })).status).toBe(200);
    session.close();
    expect((await call(endpoint, { id: 1, method: "tools/list" })).status).toBe(401);
  });
});

describe("what may not speak to it", () => {
  it("refuses anything carrying an Origin, which is every page", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);

    const response = await call(
      endpoint,
      { id: 1, method: "tools/list" },
      { headers: { origin: "https://evil.test" } }
    );
    expect(response.status).toBe(403);
  });

  it("refuses a request that arrived under a name this app never wrote", async () => {
    // What a DNS-rebinding attempt looks like on the wire: the connection is to
    // the loopback address, but the request is addressed to somebody else.
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await rawRequest(endpoint.url, {
      host: "evil.test",
      authorization: `Bearer ${endpoint.token}`
    });
    expect(response.status).toBe(403);
  });

  it("refuses a path other than the endpoint", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await fetch(endpoint.url.replace("/mcp", "/admin"), {
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}` },
      body: "{}"
    });
    expect(response.status).toBe(404);
  });

  it("refuses to open an event stream it has nothing to put on", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await call(endpoint, null, { method: "GET" });
    expect(response.status).toBe(405);
  });
});

describe("the socket's lifetime", () => {
  it("binds nothing until a run needs it, and lets go when the last one ends", async () => {
    const session = (await openSession()) as BrowserSession;
    const endpoint = endpointFrom(session);

    expect((await call(endpoint, { id: 1, method: "tools/list" })).status).toBe(200);

    session.close();
    await expect(call(endpoint, { id: 1, method: "tools/list" })).rejects.toThrow();
  });

  it("closes every session on destroy", async () => {
    const session = (await openSession()) as BrowserSession;
    const endpoint = endpointFrom(session);

    server.destroy();

    expect(existsSync(session.configPath)).toBe(false);
    await expect(call(endpoint, { id: 1, method: "tools/list" })).rejects.toThrow();
  });

  it("opens nothing once destroyed", async () => {
    server.destroy();
    expect(await openSession()).toBeNull();
  });
});

describe("the protocol", () => {
  it("completes the handshake a real client performs", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);

    const initialized = await call(endpoint, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" }
    });
    expect(initialized.status).toBe(200);
    expect(resultOf(initialized.body)["protocolVersion"]).toBe("2025-06-18");
    expect((resultOf(initialized.body)["serverInfo"] as { name: string }).name).toBe(
      MCP_SERVER_NAME
    );

    const acknowledged = await call(endpoint, {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
    expect(acknowledged.status).toBe(202);
    expect(acknowledged.body).toBeNull();

    const listed = await call(endpoint, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (resultOf(listed.body)["tools"] as { name: string }[]).map(
      (entry) => entry.name
    );
    expect(names).toContain("list_tabs");
    expect(names).toContain("navigate_tab");
  });

  it("answers a ping", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await call(endpoint, { jsonrpc: "2.0", id: 2, method: "ping" });
    expect(response.status).toBe(200);
    expect(resultOf(response.body)).toEqual({});
  });

  it("refuses a method it does not implement, rather than failing the connection", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await call(endpoint, { jsonrpc: "2.0", id: 3, method: "server/discover" });

    expect(response.status).toBe(200);
    expect((response.body as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("reports malformed JSON as a parse error", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json"
      },
      body: "{ not json"
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("answers a batch with an array", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await call(endpoint, [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" }
    ]);

    expect(Array.isArray(response.body)).toBe(true);
    expect((response.body as unknown[]).length).toBe(2);
  });

  it("refuses a body larger than it will read", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ id: 1, method: "ping", params: { pad: "x".repeat(200_000) } })
    }).catch(() => null);

    // The connection is destroyed once the cap is passed, so either a 413 or a
    // refused socket is the correct outcome. What must not happen is the body
    // being read.
    expect(response === null || response.status === 413).toBe(true);
  });
});

describe("tool calls", () => {
  it("runs a read against the granted tabs", async () => {
    const endpoint = endpointFrom((await openSession(["tab-1"])) as BrowserSession);
    await handshake(endpoint);

    const response = await call(endpoint, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_tabs", arguments: {} }
    });

    expect(resultOf(response.body)["isError"]).toBe(false);
    expect(toolText(response.body)).toContain("tab-1");
    expect(toolText(response.body)).not.toContain("tab-2");
  });

  it("keeps two sessions' grants apart", async () => {
    const first = endpointFrom((await openSession(["tab-1"])) as BrowserSession);
    const second = endpointFrom((await openSession(["tab-2"])) as BrowserSession);

    const one = await call(first, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_tabs" }
    });
    const two = await call(second, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_tabs" }
    });

    expect(toolText(one.body)).toContain("tab-1");
    expect(toolText(one.body)).not.toContain("tab-2");
    expect(toolText(two.body)).toContain("tab-2");
    expect(toolText(two.body)).not.toContain("tab-1");
  });

  it("stops for the user before changing anything", async () => {
    const endpoint = endpointFrom((await openSession(["tab-1"])) as BrowserSession);

    await call(endpoint, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "close_tab", arguments: { tabId: "tab-1" } }
    });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(closed).toEqual(["tab-1"]);
  });

  it("does nothing when the user declines", async () => {
    approve.mockResolvedValue(false);
    const endpoint = endpointFrom((await openSession(["tab-1"])) as BrowserSession);

    const response = await call(endpoint, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "close_tab", arguments: { tabId: "tab-1" } }
    });

    expect(resultOf(response.body)["isError"]).toBe(true);
    expect(toolText(response.body)).toContain("declined");
    expect(closed).toEqual([]);
  });

  it("reports a bad argument to the model rather than to the client", async () => {
    // A protocol error is the client's problem and never reaches the model. A
    // failed tool result does, which is how a model fixes its next call.
    const endpoint = endpointFrom((await openSession()) as BrowserSession);

    const response = await call(endpoint, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "open_tab", arguments: { url: "file:///etc/passwd" } }
    });

    expect(response.status).toBe(200);
    expect((response.body as { error?: unknown }).error).toBeUndefined();
    expect(resultOf(response.body)["isError"]).toBe(true);
    expect(toolText(response.body)).toContain("http or https");
  });

  it("refuses an unknown tool as a failed result", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);

    const response = await call(endpoint, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "run_shell", arguments: {} }
    });

    expect(resultOf(response.body)["isError"]).toBe(true);
  });

  it("requires a tool name", async () => {
    const endpoint = endpointFrom((await openSession()) as BrowserSession);

    const response = await call(endpoint, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {}
    });

    expect((response.body as { error: { code: number } }).error.code).toBe(-32602);
  });
});
