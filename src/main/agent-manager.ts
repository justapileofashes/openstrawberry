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
 *   - No credential passes through here. `SecretStore` will own that, and the
 *     manager only ever reports status.
 *
 * This milestone runs a scripted loop rather than a model, so the state machine,
 * the IPC contract, and the panel can be verified before a provider exists.
 */
import { writeFileSync, readFileSync } from "node:fs";
import {
  boundRuns,
  boundStepDetail,
  boundSteps,
  isTerminalStatus,
  MAX_AGENTS,
  parsePersistedAgentState,
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
  type CompanionDraftPayload,
  type CompanionIdPayload,
  type CredentialScopePayload,
  type ResolveApprovalPayload,
  type SetCredentialPayload,
  type SetOrchestratorPayload,
  type StartRunPayload,
  type UpdateCompanionPayload
} from "../shared/agents.js";
import type { BrowserPaneId, BrowserSnapshot } from "../shared/browser.js";
import { displayHostname } from "../shared/navigation.js";
import type { SecretStore } from "./secret-store.js";

/**
 * Everything an agent may do to the browser.
 *
 * Narrow on purpose. `contentsFor` is the sharp edge — it hands out a live
 * `WebContents` — so it stays behind this port and is never reachable from the
 * renderer, which only ever sees tab ids.
 */
export interface BrowserPort {
  readonly snapshot: () => BrowserSnapshot;
  readonly createTab: (paneId: BrowserPaneId, url: string) => BrowserSnapshot;
  readonly closeTab: (tabId: string) => BrowserSnapshot;
  readonly navigate: (tabId: string, address: string) => BrowserSnapshot;
  /** Null when the tab is gone or its view has been destroyed. */
  readonly contentsFor: (tabId: string) => Electron.WebContents | null;
}

export interface AgentManagerOptions {
  readonly statePath: string;
  readonly browser: BrowserPort;
  readonly secrets: SecretStore;
  readonly publish: (snapshot: AgentSnapshot) => void;
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
  command: null
};

export class AgentManager {
  private readonly statePath: string;
  private readonly browser: BrowserPort;
  private readonly secrets: SecretStore;
  private readonly publish: (snapshot: AgentSnapshot) => void;

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
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Restores companions and past runs, seeding a companion on first launch.
   *
   * Every restored run comes back non-live — `parsePersistedAgentState`
   * downgrades any running status to `paused` — so a restart can never resume an
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

    void this.driveScriptedRun(id, payload);
    return this.snapshot();
  }

  public cancelRun(runId: string): AgentSnapshot {
    const run = this.findRun(runId);
    if (run === null || isTerminalStatus(run.status)) return this.snapshot();

    // The status is the cancellation signal — the loop checks it between steps.
    // Keeping one source of truth means a cancelled run cannot look live.
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

    // Both decisions resume the loop. A denial is not a failure: the gated tool
    // returns an error saying the user declined, so the agent can choose another
    // route rather than dying on a "no".
    return this.setStatus(run.id, "acting");
  }

  /* --------------------------------------------------------------------- */
  /* Roster                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * Adds an agent and selects it.
   *
   * The id is minted here rather than accepted from the renderer, so every
   * handle in the roster is app-minted — the assumption `requireIdentifier`
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
      command: payload.command
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
            command: payload.command
          }
        : companion
    );

    return this.emit();
  }

  /**
   * Removes an agent, along with the runs that belong to it.
   *
   * The runs go because a run names its agent and nothing would resolve that
   * name afterwards — `parsePersistedAgentState` already drops such runs on the
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
      payload.command
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
   * The scripted stand-in for the model loop.
   *
   * It exercises exactly the transitions the real loop will: plan, act, report,
   * finish — checking for cancellation between steps, the way an interruptible
   * turn must.
   */
  private async driveScriptedRun(runId: string, payload: StartRunPayload): Promise<void> {
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
        : `${route.provider} · ${route.model}${
            route.baseUrl === null ? "" : ` at ${route.baseUrl}`
          }`;
    const routeLabel = `${target}${route.inherited ? " (from the orchestrator)" : ""}`;

    const script: readonly (readonly [AgentStepKind, string, string | null])[] = [
      ["thought", `Planning: ${payload.task}`, null],
      [
        "tool-result",
        `Read context from ${contextLabel}.`,
        context.map((tab) => `${tab.title} — ${tab.url}`).join("\n") || null
      ],
      [
        "message",
        `No provider adapter is wired up yet, so ${routeLabel} was not called.`,
        "The scripted loop proves the run lifecycle, the step log, and the IPC contract. Dispatching to the selected provider is the next milestone."
      ]
    ];

    for (const [kind, label, detail] of script) {
      await delay(220);
      if (!this.isRunnable(runId)) return;
      if (kind === "tool-result") this.setStatus(runId, "acting");
      this.appendStep(runId, kind, label, detail, context.at(0)?.id ?? null);
    }

    if (!this.isRunnable(runId)) return;
    this.setStatus(runId, "done");
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
      const text = readFileSync(this.statePath, "utf8").replace(/^﻿/u, "");
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
