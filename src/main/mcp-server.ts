/**
 * The socket an agent reaches the browser through.
 *
 * A local coding CLI is a separate process. It cannot be handed an object, and
 * OpenStrawberry will not hand it a credential, so the only way it can be given
 * the browser is over a transport - and the transport its tooling already speaks
 * is the Model Context Protocol over HTTP. This class is that endpoint.
 *
 * Opening a listening socket on a user's machine is the sharpest thing in this
 * application, because on the other side of it is a browser signed in to their
 * accounts. Five properties hold it shut, and each is enforced here rather than
 * assumed of the client:
 *
 *   1. **Loopback only.** The listener is bound to `127.0.0.1`, so it is not on
 *      the network at all. A port is never chosen; the operating system hands
 *      out an unused one, so nothing on this machine can reserve the address
 *      this app will use before it starts.
 *
 *   2. **A bearer token per run.** Any local process can connect to a loopback
 *      port - that is what makes an unauthenticated one a hole rather than a
 *      convenience. The token is 32 random bytes, minted when a run starts and
 *      destroyed when it ends, compared by digest so the comparison does not leak
 *      its length. It reaches the child in a file written owner-only, never in
 *      argv, for the same reason the prompt does not travel in argv: a command
 *      line is readable by every process listing on the machine.
 *
 *   3. **No socket without a run.** The listener is opened by the first session
 *      and closed by the last, so an OpenStrawberry that never runs a local agent
 *      never binds anything at all, and a token that outlived its run has nothing
 *      to connect to.
 *
 *   4. **No browser may speak to it.** A request carrying an `Origin` header is
 *      refused outright. A page cannot reach a loopback port without one, so
 *      this is the whole of the DNS-rebinding defence rather than a heuristic
 *      about which origins are friendly - and it costs nothing, because the
 *      clients this serves are processes, not pages.
 *
 *   5. **The tools are the ones in `shared/browser-tools.ts` and no others.**
 *      This file dispatches; it grants nothing. There is no route from a request
 *      body to a page except through a validated call in that closed set.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  BROWSER_TOOL_BRIEFING,
  BROWSER_TOOLS,
  interactionConsentReason,
  interactionConsentSummary
} from "../shared/browser-tools.js";
import { SnapshotRegistry } from "./snapshot-registry.js";
import {
  jsonRpcFailure,
  jsonRpcResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  MAX_MCP_REQUEST_BYTES,
  MCP_ENDPOINT_PATH,
  MCP_SERVER_NAME,
  negotiateProtocolVersion,
  parseJsonRpcBody,
  requireToolName,
  toolArguments,
  toolResultPayload,
  type JsonRpcCall,
  type JsonRpcResponse
} from "../shared/mcp.js";
import { writeFileAtomically } from "./atomic-write.js";
import {
  runNamedBrowserTool,
  type BrowserToolOptions,
  type BrowserToolPort
} from "./browser-tools.js";

/** The interface a caller opens a session with. */
export interface BrowserSessionRequest {
  /** Named in every approval prompt, so the user is told who is asking. */
  readonly agentName: string;
  /** The tabs the user granted this run. May be empty. */
  readonly tabIds: readonly string[];
  /** Stops for the user. Resolves true only on an explicit allow. */
  readonly approve: (
    toolName: string,
    summary: string,
    reason: string,
    tabId: string | null
  ) => Promise<boolean>;
}

/** A live session. Closing it revokes the token and removes the config file. */
export interface BrowserSession {
  /** The `--mcp-config` file to hand the child. Gone once `close` has run. */
  readonly configPath: string;
  readonly close: () => void;
}

interface SessionRuntime {
  readonly id: string;
  readonly digest: Buffer;
  readonly configPath: string;
  readonly agentName: string;
  readonly grants: Set<string>;
  /** The tabs this session opened for itself, kept apart from the granted ones. */
  readonly owned: Set<string>;
  /**
   * This session's captured pages.
   *
   * Per session rather than per server, so a page's field values are dropped
   * when the child that read them exits, and so two agents running at once
   * cannot resolve each other's element references.
   */
  readonly snapshots: SnapshotRegistry;
  readonly approve: BrowserSessionRequest["approve"];
  /** The once-per-run interaction question, held here so it is asked once. */
  interaction: Promise<boolean> | null;
}

export interface BrowserMcpServerOptions {
  readonly browser: BrowserToolPort;
  /** Where session config files are written. Owner-only, and removed on close. */
  readonly configDir: string;
  /** Injected in tests so a settle wait is not a real one. */
  readonly toolOptions?: BrowserToolOptions;
}

function digestOf(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time for equal-length digests, which these always are. */
function digestsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export class BrowserMcpServer {
  private readonly browser: BrowserToolPort;
  private readonly configDir: string;
  private readonly toolOptions: BrowserToolOptions;

  private readonly sessions = new Map<string, SessionRuntime>();
  private server: Server | null = null;
  private port = 0;
  private nextSessionSequence = 1;
  private destroyed = false;

  public constructor(options: BrowserMcpServerOptions) {
    this.browser = options.browser;
    this.configDir = options.configDir;
    this.toolOptions = options.toolOptions ?? {};
  }

  /**
   * Opens a session and writes the config a child is pointed at.
   *
   * Null when the listener could not be bound, which is a reason to run the
   * agent without the browser rather than to fail the run: a coding CLI with no
   * tools still answers, and that is exactly what this adapter did before.
   */
  public async open(request: BrowserSessionRequest): Promise<BrowserSession | null> {
    if (this.destroyed) return null;

    const listening = await this.ensureListening();
    if (!listening) return null;

    const id = `session-${this.nextSessionSequence++}`;
    const token = randomBytes(32).toString("base64url");
    const configPath = join(this.configDir, `mcp-${id}.json`);

    const runtime: SessionRuntime = {
      id,
      digest: digestOf(token),
      configPath,
      agentName: request.agentName,
      // Copied rather than referenced: the run's granted set is fixed at the
      // moment it starts, and only this session's own opens extend it.
      grants: new Set(request.tabIds),
      owned: new Set<string>(),
      snapshots: new SnapshotRegistry(),
      approve: request.approve,
      interaction: null
    };

    /*
     * The file is the only place the token is written. It is written whole or
     * not at all and owner-only, by the same helper every credential store here
     * uses - a config that half-exists would point a child at an endpoint it
     * cannot authenticate to, which reads to a user as the agent silently losing
     * the browser.
     */
    try {
      writeFileAtomically(
        configPath,
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: "http",
              url: `http://127.0.0.1:${this.port}${MCP_ENDPOINT_PATH}`,
              headers: { Authorization: `Bearer ${token}` }
            }
          }
        })
      );
    } catch {
      this.stopIfIdle();
      return null;
    }

    this.sessions.set(id, runtime);

    return {
      configPath,
      close: () => this.closeSession(id)
    };
  }

  /** Idempotent, and safe once the window has begun closing. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.stopListening();
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* --------------------------------------------------------------------- */

  private ensureListening(): Promise<boolean> {
    if (this.server !== null) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const server = createServer((req, res) => {
        void this.handle(req, res);
      });

      // A stalled client must not hold the process open. These are generous
      // against a tool call that stops for a user's decision, and finite.
      server.headersTimeout = 30_000;
      server.requestTimeout = 0;
      server.keepAliveTimeout = 60_000;

      const failed = (): void => {
        server.removeAllListeners();
        try {
          server.close();
        } catch {
          // Never listened; nothing to close.
        }
        resolve(false);
      };

      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          failed();
          return;
        }

        server.removeListener("error", failed);
        // Later errors are the socket's business, not a reason to crash the app.
        server.on("error", () => undefined);

        this.server = server;
        this.port = address.port;
        resolve(true);
      });
    });
  }

  private closeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;

    this.sessions.delete(id);

    try {
      rmSync(session.configPath, { force: true });
    } catch {
      // The token in it is already revoked; a file left behind authenticates
      // nothing.
    }

    this.stopIfIdle();
  }

  private stopIfIdle(): void {
    if (this.sessions.size === 0) this.stopListening();
  }

  private stopListening(): void {
    const server = this.server;
    if (server === null) return;

    this.server = null;
    this.port = 0;

    try {
      server.closeAllConnections();
      server.close();
    } catch {
      // Already gone.
    }
  }

  /* --------------------------------------------------------------------- */
  /* Transport                                                             */
  /* --------------------------------------------------------------------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    /*
     * A page always sends an Origin on a cross-origin request, and every client
     * this serves is a process, which does not. So the presence of the header is
     * the refusal, and no list of trusted origins has to be kept correct.
     */
    if (req.headers.origin !== undefined) {
      respond(res, 403, { error: "forbidden" });
      return;
    }

    // The address this app wrote into the config is a loopback literal, so a
    // request arriving under any other name did not come from that config.
    const host = req.headers.host ?? "";
    if (!host.startsWith("127.0.0.1:") && !host.startsWith("[::1]:")) {
      respond(res, 403, { error: "forbidden" });
      return;
    }

    if ((req.url ?? "") .split("?")[0] !== MCP_ENDPOINT_PATH) {
      respond(res, 404, { error: "not-found" });
      return;
    }

    /*
     * The protocol allows a client to open a server-to-client event stream with
     * a GET, and allows a server that has nothing to push to refuse it. This one
     * has nothing to push: every result is the reply to the call that asked for
     * it. The observed client tries the GET, takes the refusal, and carries on.
     */
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }

    const session = this.authenticate(req);
    if (session === null) {
      respond(res, 401, { error: "unauthorised" });
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      respond(res, 413, { error: "too-large" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      respond(res, 200, jsonRpcFailure(null, JSON_RPC_PARSE_ERROR, "Malformed JSON."));
      return;
    }

    const message = parseJsonRpcBody(parsed);
    if (message === null) {
      respond(res, 200, jsonRpcFailure(null, JSON_RPC_PARSE_ERROR, "Not a JSON-RPC request."));
      return;
    }

    const replies: JsonRpcResponse[] = [];
    for (const call of message.calls) {
      const reply = await this.dispatch(session, call);
      if (reply !== null) replies.push(reply);
    }

    // Every message was a notification. The protocol's answer to that is an
    // acknowledgement with no body, not an empty result.
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }

    respond(res, 200, message.batch ? replies : (replies[0] as JsonRpcResponse));
  }

  /**
   * The session a request belongs to, or null.
   *
   * Every live token is compared against, by digest, without stopping at the
   * first mismatch - so the time this takes depends on how many runs are open
   * and not on which one the caller guessed closest to.
   */
  private authenticate(req: IncomingMessage): SessionRuntime | null {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;

    const presented = digestOf(header.slice("Bearer ".length));

    let match: SessionRuntime | null = null;
    for (const session of this.sessions.values()) {
      if (digestsMatch(presented, session.digest)) match = session;
    }

    return match;
  }

  private async dispatch(
    session: SessionRuntime,
    call: JsonRpcCall
  ): Promise<JsonRpcResponse | null> {
    // A notification expects no reply, whatever it was about. Cancellation and
    // progress notices both land here and both are correctly ignored: this
    // server does no work that outlives the request that asked for it.
    if (call.id === null) return null;
    const id = call.id;

    switch (call.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: negotiateProtocolVersion(call.params["protocolVersion"]),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "OpenStrawberry", version: "1" },
          /*
           * The same briefing a model on an API key is given as a system prompt.
           * A schema says what a tool takes; it cannot say that references expire
           * on navigation, that the diff is the evidence an action worked, or
           * that a page's own words are not instructions. A client that reads
           * this hands it to its model, and one that ignores it is no worse off
           * than before - which is why the loop is also described in each tool's
           * own description.
           */
          instructions: BROWSER_TOOL_BRIEFING
        });

      case "ping":
        return jsonRpcResult(id, {});

      case "tools/list":
        return jsonRpcResult(id, { tools: BROWSER_TOOLS });

      case "tools/call":
        return this.callTool(session, id, call);

      default:
        return jsonRpcFailure(id, JSON_RPC_METHOD_NOT_FOUND, "Unsupported method.");
    }
  }

  private async callTool(
    session: SessionRuntime,
    id: string | number,
    call: JsonRpcCall
  ): Promise<JsonRpcResponse> {
    let name: string;
    try {
      name = requireToolName(call.params);
    } catch {
      return jsonRpcFailure(id, JSON_RPC_INVALID_PARAMS, "A tool name is required.");
    }

    let args: Record<string, unknown>;
    try {
      args = toolArguments(call.params);
    } catch {
      return jsonRpcFailure(id, JSON_RPC_INVALID_PARAMS, "Tool arguments must be an object.");
    }

    /*
     * Everything from here is the shared entrance, which is also what an agent
     * on an API key goes through. A malformed argument comes back as a failed
     * *tool result* rather than a protocol error: a protocol error is the
     * client's problem and is never shown to the model, while a tool result is,
     * and a model told which argument it got wrong fixes the call next turn.
     */
    const result = await runNamedBrowserTool(
      this.browser,
      {
        agentName: session.agentName,
        granted: (tabId) => session.grants.has(tabId),
        grant: (tabId) => {
          session.grants.add(tabId);
          session.owned.add(tabId);
        },
        ownTabs: () => session.owned,
        snapshots: session.snapshots,
        approve: session.approve,
        /*
         * Asked once for the whole session, and the answer is kept whichever way
         * it went - a user who declined is not asked again on the agent's next
         * attempt, which is what would turn one refusal into a stream of prompts.
         */
        mayInteract: () => {
          session.interaction ??= session.approve(
            "interact",
            interactionConsentSummary(session.agentName, session.grants.size),
            interactionConsentReason(),
            null
          );
          return session.interaction;
        }
      },
      name,
      args,
      this.toolOptions
    );

    return jsonRpcResult(id, toolResultPayload(result));
  }
}

/** Reads a bounded request body, or rejects once it is over the cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_MCP_REQUEST_BYTES) {
        req.destroy();
        reject(new Error("too-large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new Error("read-failed")));
  });
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

