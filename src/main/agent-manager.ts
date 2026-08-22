/**
 * Owns agent runs in the trusted process.
 *
 * The shape deliberately mirrors `BrowserManager`: an options object carrying a
 * `publish` callback, every mutation ending in `emit()`, and an idempotent
 * `destroy()` that must be safe to call twice and safe to call once the window
 * has begun closing.
 *
 * Two boundaries are load-bearing:
 *
 *   - The manager never receives `BrowserManager`. It gets a `BrowserPort`, so
 *     the set of things an agent can do to the browser is a list you can read in
 *     one place rather than "whatever the tab engine exposes".
 *   - A credential is read from SecretStore immediately before a call and
 *     handed straight to the transport. It is never stored on this class, never
 *     put in a step, and never included in an error: failures arrive as codes
 *     and are turned into wording held in this file.
 *
 * A run plans, reads its named context, then dispatches to the resolved provider
 * through an injected port. The port is optional: with none, the runtime stays
 * inert and says so, which is what keeps a build with no network stack - and
 * every test here - from making a request as a side effect of a run.
 */
import { writeFileSync, readFileSync } from "node:fs";
import {
  boundRuns,
  boundStepDetail,
  boundSteps,
  emptyTuning,
  isTerminalStatus,
  MAX_AGENTS,
  parsePersistedAgentState,
  providerDescriptor,
  resolvedProvider,
  toPersistedAgentState,
  type AgentCompanion,
  type AgentConfigStatus,
  type AgentRunState,
  type AgentRunStatus,
  type AgentSkillSummary,
  type AgentSnapshot,
  type AgentStep,
  type AgentStepKind,
  type ApprovalRequest,
  type CompanionDraftPayload,
  type CompanionIdPayload,
  type CredentialScopePayload,
  type ProviderTestPayload,
  type ResolveApprovalPayload,
  type SetCredentialPayload,
  type SetOrchestratorPayload,
  type StartRunPayload,
  type UpdateCompanionPayload
} from "../shared/agents.js";
import {
  BROWSER_TOOL_BRIEFING,
  BROWSER_TOOLS,
  interactionConsentReason,
  interactionConsentSummary
} from "../shared/browser-tools.js";
import { SnapshotRegistry } from "./snapshot-registry.js";
import type { BrowserPaneId, BrowserSnapshot } from "../shared/browser.js";
import { displayHostname } from "../shared/navigation.js";
import type { SecretStore } from "./secret-store.js";
import { MAX_PROMPT_LENGTH } from "../shared/provider-request.js";
import type {
  ChatMessage,
  ChatOutcome,
  ProviderErrorCode,
  ProviderResult
} from "../shared/provider-request.js";
import type { ProviderTestResult } from "../shared/provider-request.js";
import type { McpToolDescriptor } from "../shared/mcp.js";
import type { ProviderId } from "../shared/agents.js";
// The same allowlist the CLI transport enforces, so a route that tests clean is
// one that would actually run rather than one this check happens to permit.
import { isAllowedCommand } from "./cli-provider.js";
import { runBrowserAgent, type BrowserAgentEvent } from "./browser-agent.js";
import {
  runNamedBrowserTool,
  type BrowserToolOptions,
  type BrowserToolSession,
  type ScriptRunnerPort
} from "./browser-tools.js";

/**
 * Wording for each failure code.
 *
 * Held here rather than taken from the provider, because a provider's error body
 * is remote content and could carry anything - including, from a misconfigured
 * gateway, fragments of the request that was sent to it.
 */
const PROVIDER_ERROR_TEXT: Readonly<Record<ProviderErrorCode, string>> = {
  "no-credential": "no key is stored for it.",
  "unsupported-provider": "this build has no transport for that provider.",
  "bad-endpoint": "its endpoint is not a usable https address.",
  network: "the request did not complete.",
  timeout: "it did not answer in time.",
  redirected: "it redirected the request, which is refused.",
  unauthorised: "the stored key was rejected.",
  "rate-limited": "it is rate limiting requests.",
  "provider-error": "it returned an error.",
  "malformed-reply": "its reply could not be read.",
  "too-large": "its reply was larger than will be read.",
  cancelled: "the run was cancelled.",
  "command-not-allowed": "that program is not one this app will run.",
  "command-failed": "the command did not run successfully.",
  "no-output": "the command printed nothing."
};

/**
 * Everything an agent may do to the browser.
 *
 * Narrow on purpose. `contentsFor` is the sharp edge â€” it hands out a live
 * `WebContents` â€” so it stays behind this port and is never reachable from the
 * renderer, which only ever sees tab ids.
 */
export interface BrowserPort {
  readonly snapshot: () => BrowserSnapshot;
  readonly createTab: (paneId: BrowserPaneId, url: string) => BrowserSnapshot;
  readonly closeTab: (tabId: string) => BrowserSnapshot;
  readonly navigate: (tabId: string, address: string) => BrowserSnapshot;
  readonly goBack: (tabId: string) => BrowserSnapshot;
  readonly goForward: (tabId: string) => BrowserSnapshot;
  readonly reload: (tabId: string) => BrowserSnapshot;
  /** Null when the tab is gone or its view has been destroyed. */
  readonly contentsFor: (tabId: string) => Electron.WebContents | null;
  /**
   * A counter the tab engine bumps on every navigation, in-page ones included.
   *
   * What makes an element reference expire. A reference taken before a
   * navigation still resolves afterwards, to whatever now sits in that
   * position â€” which is not a miss but a confident action on the wrong thing.
   */
  readonly generationFor: (tabId: string) => number;
  /**
   * The size the tab is currently drawn at, or null when it is not drawn.
   *
   * Inactive panes are detached, and a view that is not composited has no
   * geometry, so every rectangle in it is zero and every click would land at the
   * origin. Asking first turns that into a refusal the agent can act on.
   */
  readonly viewportFor: (tabId: string) => { readonly width: number; readonly height: number } | null;
}

/**
 * Handing one run the browser, over a transport a separate process can reach.
 *
 * Injected, and optional. With no port no session is ever opened, which means no
 * token is minted, no config file is written, and no socket is bound - so a
 * build that has not wired this, and every test here, runs local tools exactly
 * as they ran before.
 *
 * The `approve` callback is the run's own gate handed to the session, so consent
 * is asked for in the run the user is looking at rather than somewhere the
 * transport invented.
 */
export type BrowserSessionPort = (request: {
  readonly agentName: string;
  readonly tabIds: readonly string[];
  readonly approve: (
    toolName: string,
    summary: string,
    reason: string,
    tabId: string | null
  ) => Promise<boolean>;
}) => Promise<BrowserSessionHandle | null>;

export interface BrowserSessionHandle {
  /** The file the child is pointed at. Removed by `close`. */
  readonly configPath: string;
  readonly close: () => void;
}

/**
 * Calling a model.
 *
 * Injected, and optional. With no port the runtime stays exactly as inert as it
 * was - which is what keeps every existing test, and any build that has not
 * wired a network stack, from making a request as a side effect of a run.
 */
export type ProviderPort = (request: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly credential: string | null;
  readonly prompt: string;
  /** The route's temperature, or null to leave the provider's own default. */
  readonly temperature: number | null;
  readonly signal: AbortSignal;
}) => Promise<ProviderResult>;

/**
 * Calling a model for one turn of a conversation that may use tools.
 *
 * Separate from `ProviderPort` because the two answer different questions. That
 * one asks for prose and gets prose. This one hands over a transcript and a tool
 * list, and a reply asking to call a tool is a successful answer to it rather
 * than a failure to produce one.
 *
 * Optional, and absent means every HTTP route behaves exactly as it did before
 * tools existed: one prompt, one block of text, no tool declarations sent and
 * so nothing extra paid for.
 */
export type ProviderTurnPort = (request: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly credential: string | null;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly McpToolDescriptor[];
  readonly system: string | null;
  readonly temperature: number | null;
  readonly signal: AbortSignal;
}) => Promise<ChatOutcome>;

/**
 * Running a local tool.
 *
 * Separate from `ProviderPort` because the two do genuinely different things -
 * one makes a request, the other starts a process - and collapsing them would
 * hide which of those a route is about to do. Both are optional and both end in
 * the same result type.
 */
export type CommandPort = (request: {
  readonly command: string;
  readonly prompt: string;
  /**
   * The model the agent was pinned to, or empty to leave the tool's own choice
   * alone. A CLI ships no default model here, so empty is the ordinary case -
   * and passing it on is what lets someone put a cheap model behind a route
   * they call often.
   */
  readonly model: string;
  readonly signal: AbortSignal;
  /**
   * The MCP session config the tool should load, or null for a call with no
   * tools. Null is the ordinary case: only a route that both supports the
   * browser and was given a session ever carries one.
   */
  readonly mcpConfigPath: string | null;
}) => Promise<ProviderResult>;

export interface AgentManagerOptions {
  readonly statePath: string;
  readonly browser: BrowserPort;
  readonly secrets: SecretStore;
  readonly publish: (snapshot: AgentSnapshot) => void;
  /** Absent means no model is ever called; the run reports that plainly. */
  readonly provider?: ProviderPort;
  /**
   * Absent means an agent on an API key answers from the task alone, exactly as
   * it did before the browser was reachable.
   */
  readonly providerTurn?: ProviderTurnPort;
  /** Absent means no process is ever started, and the run says so. */
  readonly command?: CommandPort;
  /** Absent means no local tool is ever handed the browser over a socket. */
  readonly browserSessions?: BrowserSessionPort;
  /** Whether a given program can be handed a session at all. */
  readonly supportsBrowserTools?: (command: string) => boolean;
  /**
   * Where a `run` script executes. Absent means the tool reports that this build
   * cannot run one, which is what every test and every headless context gets.
   */
  readonly scriptRunner?: ScriptRunnerPort;
}

/**
 * How long a gate waits for an answer.
 *
 * It has to end somewhere: on the other side is a child process holding a tool
 * call open, and a person who walked away should cost that run one refused
 * action rather than the whole of its time budget. Three minutes is long enough
 * to read a summary and decide, and well inside the browser-run budget, so an
 * expiry is reported as a decision rather than as the run timing out.
 */
export const APPROVAL_TIMEOUT_MS = 180_000;

/**
 * What a connection test asks for.
 *
 * As short as a request can be while still being a real one. The point is to
 * exercise the endpoint, the key, and the model name together â€” a request that
 * a gateway would accept but a model would reject proves nothing â€” so it is a
 * genuine completion, kept to a word so the user is not billed for curiosity.
 */
export const PROVIDER_TEST_PROMPT = "Reply with the single word: ok";

/** How long a test waits before giving up, in place of the run-length budget. */
export const PROVIDER_TEST_TIMEOUT_MS = 20_000;

/** One outstanding gate: who to tell, and when to stop waiting. */
interface PendingGate {
  readonly runId: string;
  readonly resolve: (allowed: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** The companion seeded on first launch, so the panel is never empty. */
const DEFAULT_COMPANION: AgentCompanion = {
  id: "companion-scout",
  name: "Scout",
  role: "research",
  skillPaths: [],
  // Follows the orchestrator. A seeded agent must not arrive already pinned to
  // a provider the user never chose.
  provider: null,
  model: null,
  baseUrl: null,
  command: null,
  tuning: emptyTuning()
};

export class AgentManager {
  private readonly statePath: string;
  private readonly browser: BrowserPort;
  private readonly secrets: SecretStore;
  private readonly publish: (snapshot: AgentSnapshot) => void;
  private readonly provider: ProviderPort | null;
  private readonly providerTurn: ProviderTurnPort | null;
  private readonly command: CommandPort | null;
  private readonly browserSessions: BrowserSessionPort | null;
  private readonly supportsBrowserTools: (command: string) => boolean;
  /** Passed to every tool call this runtime makes, so the set is one object. */
  private readonly toolOptions: BrowserToolOptions;
  /** One controller per live run, so cancelling abandons a request in flight. */
  private readonly inFlight = new Map<string, AbortController>();
  /** Gates a tool call is blocked on, keyed by the approval the user answers. */
  private readonly gates = new Map<string, PendingGate>();
  private nextApprovalSequence = 1;

  private companions: readonly AgentCompanion[] = [];
  private activeCompanionId: string | null = null;
  private runs: readonly AgentRunState[] = [];
  private activeRunId: string | null = null;

  private nextCompanionSequence = 1;
  private nextRunSequence = 1;
  private nextStepSequence = 1;
  private destroyed = false;

  public constructor(options: AgentManagerOptions) {
    this.statePath = options.statePath;
    this.browser = options.browser;
    this.secrets = options.secrets;
    this.publish = options.publish;
    this.provider = options.provider ?? null;
    this.providerTurn = options.providerTurn ?? null;
    this.command = options.command ?? null;
    this.browserSessions = options.browserSessions ?? null;
    // With no answer supplied, no program supports the browser. A default that
    // said yes would hand a session to a tool that has no way to load one.
    this.supportsBrowserTools = options.supportsBrowserTools ?? (() => false);
    // Built once rather than per call, and rebuilt rather than spread, because an
    // explicit `undefined` is a different thing from an absent field here.
    this.toolOptions =
      options.scriptRunner === undefined ? {} : { scriptRunner: options.scriptRunner };
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Restores companions and past runs, seeding a companion on first launch.
   *
   * Every restored run comes back non-live â€” `parsePersistedAgentState`
   * downgrades any running status to `paused` â€” so a restart can never resume an
   * action that was waiting on an approval.
   */
  public restore(): void {
    const state = parsePersistedAgentState(this.readStateFile());

    this.companions =
      state.companions.length > 0 ? state.companions : [DEFAULT_COMPANION];
    this.activeCompanionId = state.activeCompanionId;
    this.runs = state.runs;

    for (const run of this.runs) {
      const suffix = Number.parseInt(run.id.replace(/^run-/u, ""), 10);
      if (Number.isInteger(suffix) && suffix >= this.nextRunSequence) {
        this.nextRunSequence = suffix + 1;
      }
    }

    // Minting past a restored id keeps handles unique across restarts, which is
    // what lets a run keep naming the agent that started it.
    for (const companion of this.companions) {
      const suffix = Number.parseInt(companion.id.replace(/^companion-/u, ""), 10);
      if (Number.isInteger(suffix) && suffix >= this.nextCompanionSequence) {
        this.nextCompanionSequence = suffix + 1;
      }
    }

    // The most recent run is what the panel opens on, so a paused gate is the
    // first thing the user sees rather than something they must go find.
    this.activeRunId = this.runs.at(-1)?.id ?? null;

    this.emit();
  }

  /** Safe to call twice, and safe once the window has begun closing. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Requests still in flight are abandoned; the window is going away and
    // nothing will be there to receive a reply.
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();

    // A gate nobody can answer any more is a refusal, not a wait. Settling them
    // is what lets the tool call on the far side of the socket return, so the
    // child exits rather than being killed on its timeout.
    for (const id of [...this.gates.keys()]) this.settleGate(id, false);

    try {
      this.persistState();
    } catch {
      // State that cannot be written must never block a clean exit.
    }
  }

  /* --------------------------------------------------------------------- */
  /* Runs                                                                  */
  /* --------------------------------------------------------------------- */

  public startRun(payload: StartRunPayload): AgentSnapshot {
    if (this.destroyed) return this.snapshot();

    const companion = this.companions.find((entry) => entry.id === payload.companionId);
    if (companion === undefined) return this.snapshot();

    const id = `run-${this.nextRunSequence++}`;
    const run: AgentRunState = {
      id,
      companionId: companion.id,
      task: payload.task,
      status: "planning",
      steps: [],
      pendingApproval: null,
      startedAt: Date.now(),
      endedAt: null
    };

    this.runs = boundRuns([...this.runs, run]);
    this.activeRunId = id;
    this.emit();

    void this.driveRun(id, payload);
    return this.snapshot();
  }

  public cancelRun(runId: string): AgentSnapshot {
    const run = this.findRun(runId);
    if (run === null || isTerminalStatus(run.status)) return this.snapshot();

    // The status is the cancellation signal â€” the loop checks it between steps.
    // Keeping one source of truth means a cancelled run cannot look live.
    // A request already in flight is abandoned rather than left to finish into
    // a run nobody is watching.
    this.inFlight.get(runId)?.abort();
    this.inFlight.delete(runId);

    // An outstanding gate is refused rather than left hanging: the tool call
    // waiting on it belongs to the run being cancelled.
    this.denyGatesFor(runId);
    this.updateRun(runId, (current) => ({ ...current, pendingApproval: null }));

    this.appendStep(runId, "message", "Cancelled by you.", null, null);
    return this.setStatus(runId, "cancelled");
  }

  /**
   * Records a decision on a pending gate.
   *
   * The decision is matched against the stored request rather than trusted from
   * the payload: a renderer that guesses an approval id must still name one that
   * is actually outstanding.
   */
  public resolveApproval(payload: ResolveApprovalPayload): AgentSnapshot {
    const run = this.runs.find(
      (entry) => entry.pendingApproval?.id === payload.approvalId
    );
    if (run === undefined || run.pendingApproval === null) return this.snapshot();

    const { toolName, tabId } = run.pendingApproval;
    this.updateRun(run.id, (current) => ({ ...current, pendingApproval: null }));
    this.appendStep(
      run.id,
      payload.decision === "allow" ? "message" : "error",
      payload.decision === "allow" ? `You allowed ${toolName}.` : `You denied ${toolName}.`,
      null,
      tabId
    );

    // The tool call is blocked on this. Releasing it after the state has been
    // updated means the run already reads as resumed by the time the action it
    // was waiting on begins.
    this.settleGate(payload.approvalId, payload.decision === "allow");

    // Both decisions resume the loop. A denial is not a failure: the gated tool
    // returns an error saying the user declined, so the agent can choose another
    // route rather than dying on a "no".
    return this.setStatus(run.id, "acting");
  }

  /* --------------------------------------------------------------------- */
  /* Gates                                                                 */
  /* --------------------------------------------------------------------- */

  /**
   * Stops a run for the user, and answers with what they said.
   *
   * This is the producer the approval machinery was built for: the run goes to
   * `awaiting-approval`, the panel shows the request, and the tool call on the
   * other side of the socket stays open until somebody decides.
   *
   * A run that is gone, finished, cancelled, or already holding a gate is
   * refused immediately rather than queued. One outstanding request at a time is
   * what the state can express - `pendingApproval` is a field, not a list - and
   * an agent that fires two actions at once should be told no to the second
   * rather than have it silently applied later against a browser that has since
   * moved.
   */
  private requestApproval(
    runId: string,
    toolName: string,
    summary: string,
    reason: string,
    tabId: string | null
  ): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);

    const run = this.findRun(runId);
    if (run === null || isTerminalStatus(run.status) || run.pendingApproval !== null) {
      return Promise.resolve(false);
    }

    const id = `approval-${this.nextApprovalSequence++}`;
    const request: ApprovalRequest = { id, runId, toolName, summary, reason, tabId };

    this.updateRun(runId, (current) => ({ ...current, pendingApproval: request }));
    this.appendStep(runId, "tool-call", summary, null, tabId);
    this.setStatus(runId, "awaiting-approval");

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.expireGate(id), APPROVAL_TIMEOUT_MS);
      // Node keeps the process alive for a pending timer, and a gate nobody
      // answers must not be the reason the app will not quit.
      timer.unref?.();
      this.gates.set(id, { runId, resolve, timer });
    });
  }

  /** Releases one waiting tool call. Unknown ids are already settled. */
  private settleGate(approvalId: string, allowed: boolean): void {
    const gate = this.gates.get(approvalId);
    if (gate === undefined) return;

    this.gates.delete(approvalId);
    clearTimeout(gate.timer);
    gate.resolve(allowed);
  }

  /** An unanswered gate becomes a refusal, and says so in the run. */
  private expireGate(approvalId: string): void {
    const gate = this.gates.get(approvalId);
    if (gate === undefined) return;

    const run = this.findRun(gate.runId);
    if (run?.pendingApproval?.id === approvalId) {
      this.updateRun(gate.runId, (current) => ({ ...current, pendingApproval: null }));
      this.appendStep(
        gate.runId,
        "error",
        `No answer to ${run.pendingApproval.toolName}, so it was refused.`,
        null,
        run.pendingApproval.tabId
      );
      if (!isTerminalStatus(run.status)) this.setStatus(gate.runId, "acting");
    }

    this.settleGate(approvalId, false);
  }

  private denyGatesFor(runId: string): void {
    for (const [id, gate] of [...this.gates]) {
      if (gate.runId === runId) this.settleGate(id, false);
    }
  }

  /* --------------------------------------------------------------------- */
  /* Roster                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * Adds an agent and selects it.
   *
   * The id is minted here rather than accepted from the renderer, so every
   * handle in the roster is app-minted â€” the assumption `requireIdentifier`
   * encodes everywhere else. At the cap, the call is a no-op: the roster is
   * bounded in the contract, not by the renderer's restraint.
   */
  public createCompanion(payload: CompanionDraftPayload): AgentSnapshot {
    if (this.destroyed || this.companions.length >= MAX_AGENTS) return this.snapshot();

    const companion: AgentCompanion = {
      id: `companion-${this.nextCompanionSequence++}`,
      name: payload.name,
      role: payload.role,
      skillPaths: [],
      provider: payload.provider,
      model: payload.model,
      baseUrl: payload.baseUrl,
      command: payload.command,
      tuning: payload.tuning
    };

    this.companions = [...this.companions, companion];
    this.activeCompanionId = companion.id;
    return this.emit();
  }

  /** Replaces an agent's editable fields. Its id, skills, and runs are untouched. */
  public updateCompanion(payload: UpdateCompanionPayload): AgentSnapshot {
    if (this.destroyed) return this.snapshot();

    this.companions = this.companions.map((companion) =>
      companion.id === payload.companionId
        ? {
            ...companion,
            name: payload.name,
            role: payload.role,
            provider: payload.provider,
            model: payload.model,
            baseUrl: payload.baseUrl,
            command: payload.command,
            tuning: payload.tuning
          }
        : companion
    );

    return this.emit();
  }

  /**
   * Removes an agent, along with the runs that belong to it.
   *
   * The runs go because a run names its agent and nothing would resolve that
   * name afterwards â€” `parsePersistedAgentState` already drops such runs on the
   * next load, so keeping them in memory would only make live state disagree
   * with restored state.
   *
   * The last agent cannot be removed. An empty roster has no composer to type
   * into, and the seed would silently reappear on the next launch.
   */
  public deleteCompanion(payload: CompanionIdPayload): AgentSnapshot {
    if (this.destroyed || this.companions.length <= 1) return this.snapshot();
    if (!this.companions.some((entry) => entry.id === payload.companionId)) {
      return this.snapshot();
    }

    this.companions = this.companions.filter(
      (companion) => companion.id !== payload.companionId
    );
    this.runs = this.runs.filter((run) => run.companionId !== payload.companionId);

    // Its keys go with it. A credential outliving the only thing that could use
    // it is a secret kept for no reason.
    this.secrets.forgetCompanion(payload.companionId);

    if (this.activeCompanionId === payload.companionId) this.activeCompanionId = null;
    if (!this.runs.some((run) => run.id === this.activeRunId)) {
      this.activeRunId = this.runs.at(-1)?.id ?? null;
    }

    return this.emit();
  }

  /** Points the composer at an agent. An unknown id leaves the selection alone. */
  public selectCompanion(payload: CompanionIdPayload): AgentSnapshot {
    if (!this.companions.some((entry) => entry.id === payload.companionId)) {
      return this.snapshot();
    }

    this.activeCompanionId = payload.companionId;
    return this.emit();
  }

  /* --------------------------------------------------------------------- */
  /* Config and skills                                                     */
  /* --------------------------------------------------------------------- */

  /** Status only. The store is the sole holder of the key. */
  public getConfig(): AgentConfigStatus {
    return this.secrets.status();
  }

  /**
   * Stores a provider key.
   *
   * The payload is dropped the moment it reaches the store, and what goes back
   * to the renderer is status. Throws when the OS cannot encrypt, which the
   * router turns into a refusal rather than a silent plaintext write.
   */
  public setCredential(payload: SetCredentialPayload): AgentConfigStatus {
    // An agent-scoped key must name an agent that exists, or it would be a
    // secret stored against nothing and never reachable again.
    if (
      payload.companionId !== null &&
      !this.companions.some((entry) => entry.id === payload.companionId)
    ) {
      return this.getConfig();
    }

    const status = this.secrets.setCredential(
      payload.provider,
      payload.key,
      payload.companionId
    );
    this.emit();
    return status;
  }

  public clearCredential(payload: CredentialScopePayload): AgentConfigStatus {
    const status = this.secrets.clearCredential(payload.provider, payload.companionId);
    this.emit();
    return status;
  }

  /**
   * Repoints the orchestrator, and with it every agent that follows it.
   *
   * Stored even when that provider has no key: the intent is the user's, and the
   * missing key is reported rather than treated as a reason to refuse.
   */
  public setOrchestrator(payload: SetOrchestratorPayload): AgentConfigStatus {
    const status = this.secrets.setOrchestrator(
      payload.provider,
      payload.model,
      payload.baseUrl,
      payload.command,
      payload.tuning
    );
    this.emit();
    return status;
  }

  public listSkills(): readonly AgentSkillSummary[] {
    return [];
  }

  /* --------------------------------------------------------------------- */
  /* Snapshot                                                              */
  /* --------------------------------------------------------------------- */

  public snapshot(): AgentSnapshot {
    return {
      companions: this.companions,
      activeCompanionId: this.activeCompanionId,
      runs: this.runs,
      activeRunId: this.activeRunId,
      config: this.getConfig()
    };
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  private emit(): AgentSnapshot {
    const next = this.snapshot();
    if (!this.destroyed) this.publish(next);
    return next;
  }

  private findRun(runId: string): AgentRunState | null {
    return this.runs.find((run) => run.id === runId) ?? null;
  }

  private updateRun(
    runId: string,
    change: (run: AgentRunState) => AgentRunState
  ): void {
    this.runs = this.runs.map((run) => (run.id === runId ? change(run) : run));
  }

  private setStatus(runId: string, status: AgentRunStatus): AgentSnapshot {
    this.updateRun(runId, (run) => ({
      ...run,
      status,
      endedAt: isTerminalStatus(status) ? (run.endedAt ?? Date.now()) : null
    }));
    return this.emit();
  }

  private appendStep(
    runId: string,
    kind: AgentStepKind,
    label: string,
    detail: string | null,
    tabId: string | null
  ): AgentSnapshot {
    const step: AgentStep = {
      id: `step-${this.nextStepSequence++}`,
      kind,
      label,
      detail: boundStepDetail(detail),
      tabId,
      at: Date.now()
    };

    this.updateRun(runId, (run) => ({ ...run, steps: boundSteps([...run.steps, step]) }));
    return this.emit();
  }

  /**
   * Drives one run from a task to an answer.
   *
   * This used to open with two written-out steps and a delay, standing in for a
   * model loop that did not exist yet. It does now â€” the tool loop in
   * `browser-agent.ts` on an API key, and the CLI's own loop over MCP â€” so the
   * theatre is gone and every step in the log after this one is something that
   * actually happened.
   *
   * What is left before the model is called is the one step the model cannot
   * write: what it was asked, and which tabs it was given. That is the record of
   * the grant, and it belongs in the log whether the provider answers or not.
   */
  private async driveRun(runId: string, payload: StartRunPayload): Promise<void> {
    const tabs = this.browser.snapshot().tabs;
    const context = payload.tabIds
      .map((tabId) => tabs.find((tab) => tab.id === tabId))
      .filter((tab): tab is (typeof tabs)[number] => tab !== undefined);

    const contextLabel =
      context.length === 0
        ? "no tabs"
        : context.map((tab) => displayHostname(tab.url)).join(", ");

    // Named here so the log says which provider this run would have used, and
    // whether that came from the agent or from the orchestrator it follows.
    const companion =
      this.companions.find((entry) => entry.id === payload.companionId) ?? null;
    const route = resolvedProvider(companion, this.getConfig());
    // A CLI route names the program rather than an endpoint, because what would
    // happen next is a process starting on this machine, not a request leaving.
    const target =
      route.command !== null
        ? `the ${route.command} command`
        : `${route.provider} Â· ${route.model}${
            route.baseUrl === null ? "" : ` at ${route.baseUrl}`
          }`;
    const routeLabel = `${target}${route.inherited ? " (from the orchestrator)" : ""}`;

    this.appendStep(
      runId,
      "thought",
      `${payload.task}`,
      /*
       * Addresses rather than titles. A `thought` keeps its detail on disk, and
       * a title is text the page chose - it belongs to the same class as the
       * page's body, which this file is careful never to persist. The address is
       * already in the session file, so naming it here adds nothing new.
       */
      context.length === 0
        ? `Using ${routeLabel}. No tabs were granted, so the browser tools have nothing to look at.`
        : `Using ${routeLabel}. Granted:\n${context.map((tab) => `${tab.id} â€” ${tab.url}`).join("\n")}`,
      context.at(0)?.id ?? null
    );

    if (!this.isRunnable(runId)) return;
    this.setStatus(runId, "acting");
    if (!this.isRunnable(runId)) return;

    await this.callModel(runId, payload, route, routeLabel, contextLabel, context.at(0)?.id ?? null);

    if (!this.isRunnable(runId)) return;
    this.setStatus(runId, "done");
  }

  /**
   * Dispatches to the resolved provider, or explains why it did not.
   *
   * Every outcome ends as a step the user can read. A missing key, an
   * unsupported route, and a provider that refused are all things they can act
   * on, so none of them is swallowed - and none of them carries a provider's own
   * error text, which is remote content.
   */
  /**
   * Dispatches one prompt for one agent, and returns what came back.
   *
   * The route resolution, the credential read, and the choice between a request
   * and a process all live here, so a plan step and a chat turn reach a provider
   * by exactly the same path. Two paths would be two places for the credential
   * rule to be got right.
   *
   * Never throws: a broken port is a failure code, not an exception for the
   * caller to handle.
   */
  public async dispatch(
    companionId: string,
    prompt: string,
    signal: AbortSignal,
    /**
     * The run to hand the browser to, and the tabs it was granted.
     *
     * Null means no session, which is what a plan step passes: a step is
     * executed outside any `AgentRunState`, so there is nowhere to raise an
     * approval and no panel showing one. Orchestrated work reaches the browser
     * when the graph grows its own gate, not by borrowing a run's.
     */
    grant: { readonly runId: string; readonly tabIds: readonly string[] } | null = null
  ): Promise<ProviderResult> {
    const companion = this.companions.find((entry) => entry.id === companionId) ?? null;
    const route = resolvedProvider(companion, this.getConfig());

    if (route.command !== null) {
      if (this.command === null) return { ok: false, code: "unsupported-provider" };

      const command = route.command;
      const run = this.command;
      return this.withBrowserSession(command, companion, grant, async (mcpConfigPath) => {
        try {
          return await run({
            command,
            prompt:
              mcpConfigPath === null ? prompt : `${BROWSER_TOOL_BRIEFING}\n\n${prompt}`,
            model: route.model,
            signal,
            mcpConfigPath
          });
        } catch {
          return { ok: false, code: "command-failed" };
        }
      });
    }

    if (this.provider === null) return { ok: false, code: "unsupported-provider" };

    const descriptor = providerDescriptor(route.provider);
    if (descriptor === null) return { ok: false, code: "unsupported-provider" };

    try {
      return await this.provider({
        provider: descriptor.id,
        model: route.model,
        baseUrl: route.baseUrl,
        // Read immediately before the call and handed straight on; never held.
        credential: this.secrets.readCredential(descriptor.id, companionId),
        prompt,
        temperature: route.tuning.temperature,
        signal
      });
    } catch {
      return { ok: false, code: "network" };
    }
  }

  /* --------------------------------------------------------------------- */
  /* Trying a configuration                                                */
  /* --------------------------------------------------------------------- */

  /**
   * Tries a route the user has typed but not yet applied.
   *
   * Deliberately not "test the saved configuration". The button exists to answer
   * a question about a form, and testing what is already stored would answer a
   * different one â€” leaving the user to apply a broken setting to find out.
   *
   * Nothing here is written. The stored credential is read exactly as a run
   * reads it and handed straight to the port, and what comes back is a code:
   * neither the key nor the provider's reply survives this method.
   *
   * A CLI route is not called at all. Running the program to see whether it runs
   * would start a process, and possibly a billed session, to answer a question
   * the user only asked about configuration â€” so the check is that the program
   * is one this build will execute, which is the thing that actually varies.
   */
  public async testProvider(
    payload: ProviderTestPayload,
    signal: AbortSignal
  ): Promise<ProviderTestResult> {
    const descriptor = providerDescriptor(payload.provider);
    if (descriptor === null) return { ok: false, code: "unsupported-provider" };

    const startedAt = Date.now();

    if (descriptor.transport === "cli") {
      const command = payload.command ?? descriptor.defaultCommand;
      if (command === null) return { ok: false, code: "unsupported-provider" };
      if (this.command === null) return { ok: false, code: "unsupported-provider" };
      return isAllowedCommand(command)
        ? { ok: true, elapsedMs: Date.now() - startedAt }
        : { ok: false, code: "command-not-allowed" };
    }

    if (this.provider === null) return { ok: false, code: "unsupported-provider" };

    try {
      const result = await this.provider({
        provider: descriptor.id,
        model: payload.model ?? descriptor.defaultModel,
        baseUrl: payload.baseUrl,
        credential: this.secrets.readCredential(descriptor.id, payload.companionId),
        prompt: PROVIDER_TEST_PROMPT,
        temperature: payload.tuning.temperature,
        signal
      });

      // The text is discarded on purpose. That the provider answered at all is
      // the entire result; what it said is remote content with nowhere to go.
      return result.ok
        ? { ok: true, elapsedMs: Date.now() - startedAt }
        : { ok: false, code: result.code };
    } catch {
      return { ok: false, code: "network" };
    }
  }

  /**
   * One run's authority over the browser, for a model this process is driving.
   *
   * The same object an MCP client's session hands to the executor, built here
   * because there is no separate process to mint a token for. The grant set is
   * held in the closure rather than on the class: it belongs to this run, it
   * lasts exactly as long as the loop does, and nothing else can widen it.
   */
  private browserToolSession(
    runId: string,
    tabIds: readonly string[],
    agentName: string
  ): BrowserToolSession {
    const grants = new Set(tabIds);
    const owned = new Set<string>();
    /*
     * Captured pages live and die with the run. Holding them here rather than
     * beside the browser is what keeps a signed-in page's field values out of
     * memory once the run that read them has finished, and what stops two runs
     * resolving each other's references.
     */
    const snapshots = new SnapshotRegistry();

    /*
     * Asked once, then remembered â€” including a refusal, so a user who said no
     * is not asked again every time the agent tries.
     */
    let interaction: Promise<boolean> | null = null;

    return {
      agentName,
      granted: (tabId) => grants.has(tabId),
      grant: (tabId) => {
        grants.add(tabId);
        owned.add(tabId);
      },
      ownTabs: () => owned,
      snapshots,
      approve: (toolName, summary, reason, tabId) =>
        this.requestApproval(runId, toolName, summary, reason, tabId),
      mayInteract: () => {
        interaction ??= this.requestApproval(
          runId,
          "interact",
          interactionConsentSummary(agentName, grants.size),
          interactionConsentReason(),
          null
        );
        return interaction;
      }
    };
  }

  /** Turns what the loop did into steps the user can read. */
  private recordAgentEvent(runId: string, event: BrowserAgentEvent): void {
    if (event.kind === "thought") {
      this.appendStep(runId, "thought", event.text, null, null);
      return;
    }

    if (event.kind === "tool-call") {
      this.appendStep(runId, "tool-call", `Using ${event.tool}`, event.detail, event.tabId);
      return;
    }

    this.appendStep(
      runId,
      event.failed ? "error" : "tool-result",
      event.failed ? `${event.tool} did not succeed` : `${event.tool} answered`,
      event.detail,
      event.tabId
    );
  }

  /**
   * Opens a browser session around one call, and closes it afterwards.
   *
   * The session's lifetime is the call's lifetime, exactly. That is the point:
   * the token it mints authenticates nothing once the child that was given it
   * has exited, and the config file carrying that token is removed on the way
   * out - so a config left on disk by a crash is a file naming a dead port and a
   * revoked secret rather than a way in.
   *
   * A session that cannot be opened is not an error. The body runs with no
   * config path, which is the call this adapter made before the browser existed:
   * a coding CLI with no tools still answers the question it was asked.
   */
  private async withBrowserSession<T>(
    command: string,
    companion: AgentCompanion | null,
    grant: { readonly runId: string; readonly tabIds: readonly string[] } | null,
    body: (mcpConfigPath: string | null) => Promise<T>
  ): Promise<T> {
    const sessions = this.browserSessions;
    if (grant === null || sessions === null || !this.supportsBrowserTools(command)) {
      return body(null);
    }

    let session: BrowserSessionHandle | null = null;
    try {
      session = await sessions({
        // Named in every gate, so the user is told which of their agents is
        // asking rather than being asked to trust "an agent".
        agentName: companion?.name ?? "An agent",
        tabIds: grant.tabIds,
        approve: (toolName, summary, reason, tabId) =>
          this.requestApproval(grant.runId, toolName, summary, reason, tabId)
      });
    } catch {
      session = null;
    }

    try {
      return await body(session === null ? null : session.configPath);
    } finally {
      session?.close();
      // The child is gone. Anything still waiting on this run's gate is waiting
      // for a process that will never read the answer, and leaving the run
      // parked on `awaiting-approval` would show the user a decision that no
      // longer decides anything.
      this.denyGatesFor(grant.runId);
      if (this.findRun(grant.runId)?.pendingApproval != null) {
        this.updateRun(grant.runId, (current) => ({ ...current, pendingApproval: null }));
      }
    }
  }

  private async callModel(
    runId: string,
    payload: StartRunPayload,
    route: ReturnType<typeof resolvedProvider>,
    routeLabel: string,
    contextLabel: string,
    tabId: string | null
  ): Promise<void> {
    if (this.provider === null) {
      this.appendStep(
        runId,
        "message",
        `No provider transport is available in this build, so ${routeLabel} was not called.`,
        null,
        tabId
      );
      return;
    }

    const companion =
      this.companions.find((entry) => entry.id === payload.companionId) ?? null;

    /*
     * A CLI route starts a program on this machine rather than making a
     * request, so it takes its own port. Both end in the same `ProviderResult`,
     * which is what lets the reporting below be shared: the run log says what
     * happened without the user needing to know which kind of route it was.
     */
    if (route.command !== null) {
      if (this.command === null) {
        this.appendStep(
          runId,
          "message",
          `${routeLabel} is a local command, and this build has no way to run one.`,
          null,
          tabId
        );
        return;
      }

      const controller = new AbortController();
      this.inFlight.set(runId, controller);

      const command = route.command;
      const runCommand = this.command;

      /*
       * The one place a run is handed the browser. The grant is the run's own
       * id and the tabs the user picked when they started it - not every tab
       * that happens to be open - so what an agent can see is what somebody
       * chose to show it.
       */
      let outcome: ProviderResult;
      try {
        outcome = await this.withBrowserSession(
          command,
          companion,
          { runId, tabIds: payload.tabIds },
          (mcpConfigPath) =>
            runCommand({
              command,
              prompt:
                mcpConfigPath === null
                  ? payload.task
                  : `${BROWSER_TOOL_BRIEFING}\n\n${payload.task}`,
              model: route.model,
              signal: controller.signal,
              mcpConfigPath
            })
        );
      } catch {
        outcome = { ok: false, code: "command-failed" };
      } finally {
        this.inFlight.delete(runId);
      }

      if (!this.isRunnable(runId)) return;
      this.reportOutcome(runId, outcome, routeLabel, tabId);
      return;
    }

    /*
     * `resolvedProvider` returns a plain string, because it also serves the
     * chrome, which renders whatever was stored. Narrowing it through the
     * descriptor rather than casting means a provider the app no longer ships
     * reports as unsupported instead of being sent to a transport that has no
     * table entry for it.
     */
    const descriptor = providerDescriptor(route.provider);
    if (descriptor === null) {
      this.appendStep(
        runId,
        "error",
        `${routeLabel} is not a provider this build ships.`,
        null,
        tabId
      );
      return;
    }

    const credential = this.secrets.readCredential(descriptor.id, payload.companionId);

    const controller = new AbortController();
    this.inFlight.set(runId, controller);

    /*
     * An agent on an API key drives the browser too.
     *
     * The route has no separate process to hand a socket to, so the tool loop
     * runs here instead: the tools go out with the request, a reply asking for
     * one is executed against the same session an MCP client would have got,
     * and the answer goes back on the next turn. `runNamedBrowserTool` is the
     * shared floor under both, which is what makes "the same tools, the same
     * grants, the same gate" a fact about the code rather than an intention.
     */
    if (this.providerTurn !== null) {
      const turn = this.providerTurn;
      const session = this.browserToolSession(runId, payload.tabIds, companion?.name ?? "An agent");

      let outcome: ProviderResult;
      try {
        outcome = await runBrowserAgent({
          // Bounded here rather than in the transport, because the transport
          // now renders a transcript and slicing the middle of one would cut a
          // tool result away from the call it answers.
          task: `${payload.task}\n\nOpen tabs: ${contextLabel}`.slice(0, MAX_PROMPT_LENGTH),
          signal: controller.signal,
          contextWindow: route.tuning.contextWindow,
          turn: (messages, withTools, signal) =>
            turn({
              provider: descriptor.id,
              model: route.model,
              baseUrl: route.baseUrl,
              credential,
              messages,
              tools: withTools ? BROWSER_TOOLS : [],
              system: withTools ? BROWSER_TOOL_BRIEFING : null,
              temperature: route.tuning.temperature,
              signal
            }),
          runTool: (call) =>
            runNamedBrowserTool(
              this.browser,
              session,
              call.name,
              call.arguments,
              this.toolOptions
            ),
          record: (event) => this.recordAgentEvent(runId, event)
        });
      } catch {
        outcome = { ok: false, code: "network" };
      } finally {
        this.inFlight.delete(runId);
        this.denyGatesFor(runId);
        if (this.findRun(runId)?.pendingApproval != null) {
          this.updateRun(runId, (current) => ({ ...current, pendingApproval: null }));
        }
      }

      if (!this.isRunnable(runId)) return;
      this.reportOutcome(runId, outcome, routeLabel, tabId, descriptor.label);
      return;
    }

    let result: ProviderResult;
    try {
      result = await this.provider({
        provider: descriptor.id,
        model: route.model,
        baseUrl: route.baseUrl,
        credential,
        // The context is named, not pasted: a page's whole text is not the
        // agent's to send anywhere until context grants exist.
        prompt: `${payload.task}\n\nOpen tabs: ${contextLabel}`,
        temperature: route.tuning.temperature,
        signal: controller.signal
      });
    } catch {
      // The port is documented never to throw; treating a broken one as a
      // network failure keeps a run from dying on a contract violation.
      result = { ok: false, code: "network" };
    } finally {
      this.inFlight.delete(runId);
    }

    if (!this.isRunnable(runId)) return;
    this.reportOutcome(runId, result, routeLabel, tabId, descriptor.label);
  }

  /**
   * Turns a route's outcome into a step.
   *
   * Shared by both transports, and the only place a failure becomes words. The
   * wording is held in this file rather than taken from the provider or the
   * tool, because both produce remote or local text that can echo whatever was
   * sent to them.
   */
  private reportOutcome(
    runId: string,
    result: ProviderResult,
    routeLabel: string,
    tabId: string | null,
    replyLabel = "The command"
  ): void {
    if (result.ok) {
      this.appendStep(runId, "message", `${replyLabel} replied.`, result.text, tabId);
      return;
    }

    this.appendStep(
      runId,
      "error",
      `${routeLabel} could not be reached: ${PROVIDER_ERROR_TEXT[result.code]}`,
      null,
      tabId
    );
  }

  /** False once the run was cancelled, finished, or the process is tearing down. */
  private isRunnable(runId: string): boolean {
    if (this.destroyed) return false;
    const run = this.findRun(runId);
    return run !== null && !isTerminalStatus(run.status);
  }

  private readStateFile(): unknown {
    try {
      // Strip a byte-order mark, which an editor or sync tool could introduce
      // and which would otherwise discard the whole file.
      const text = readFileSync(this.statePath, "utf8").replace(/^ï»¿/u, "");
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private persistState(): void {
    const state = toPersistedAgentState(this.snapshot());
    writeFileSync(this.statePath, JSON.stringify(state), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}

