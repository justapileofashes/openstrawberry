/**
 * Agent state contracts shared by the main process and the chrome.
 *
 * Three rules govern everything here:
 *
 *   - Snapshots are what the renderer is allowed to know. A companion's
 *     provider credential has no field on any type in this file, so it is
 *     structurally impossible for one to reach the chrome. The shape is the
 *     guarantee, exactly as it is for `PersistedSession` in `browser.ts`.
 *   - Every run is reviewable. A step log and an explicit approval request are
 *     part of the contract rather than an optional debugging surface, because a
 *     side effect the user cannot see coming is the thing this design exists to
 *     prevent.
 *   - A restored run is never live. Statuses that imply a running loop are
 *     downgraded on load, so a gate cannot be crossed by restarting the app.
 */

import {
  IpcValidationError,
  MAX_COLLECTION_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_TEXT_LENGTH,
  requireArray,
  requireIdentifier,
  requireInteger,
  requireOneOf,
  requirePlainObject,
  requireString
} from "./ipc-validation.js";

/* ------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * A task is prose the user typed, so it needs more room than the 2048-character
 * `MAX_TEXT_LENGTH` allowed for incidental strings — but it is still bounded, so
 * a hostile renderer cannot force unbounded allocation in the trusted process.
 */
export const MAX_TASK_LENGTH = 8192;

/** Bounds one step's expandable detail. Page text is trimmed to fit this. */
export const MAX_STEP_DETAIL_LENGTH = 4096;

/** Caps the retained transcript so a long run cannot grow the snapshot forever. */
export const MAX_STEPS_RETAINED = 200;

/** Caps retained run history. Older runs are dropped oldest-first. */
export const MAX_RUNS_RETAINED = 20;

/** How many tabs the user may hand a single run as context. */
export const MAX_CONTEXT_TABS = 32;

/** Any plausible epoch-millisecond timestamp, through the year 2100. */
export const MAX_TIMESTAMP = 4_102_444_800_000;

/**
 * Provider credentials are long opaque strings. This bound is generous enough
 * for every provider's key format and short enough to stay a fixed cost.
 */
export const MAX_CREDENTIAL_LENGTH = 512;

/** An agent's display name. Long enough to be descriptive, short enough to fit. */
export const MAX_AGENT_NAME_LENGTH = 48;

/** Bounds a model name, which is an identifier rather than prose. */
export const MAX_MODEL_LENGTH = 96;

/** Bounds a provider endpoint. Real base URLs are far shorter than this. */
export const MAX_BASE_URL_LENGTH = 512;

/** Bounds an executable path. Long enough for a nested install directory. */
export const MAX_COMMAND_LENGTH = 512;

/**
 * Bounds the name a user gives one provider configuration.
 *
 * The same bound as an agent's name, and for the same reason: it is a label a
 * human reads in a list, not a field anything routes on.
 */
export const MAX_PROVIDER_LABEL_LENGTH = 48;

/**
 * Bounds a declared context window, in tokens.
 *
 * The floor is low enough for the smallest model anyone would point this at and
 * high enough that a typo of zero is rejected rather than silently starving the
 * transcript. The ceiling is well past any shipping model, so it bounds the
 * arithmetic without pretending to know what will exist next year.
 */
export const MIN_CONTEXT_WINDOW = 1_024;
export const MAX_CONTEXT_WINDOW = 10_000_000;

/**
 * The sampling temperature range every provider here accepts.
 *
 * Anthropic tops out at 1 and OpenAI at 2. The wider bound is taken because a
 * value this app refuses is a value the user cannot try, while a value the
 * provider refuses comes back as that provider's own error — which is the
 * honest place for the disagreement to surface.
 */
export const MAX_TEMPERATURE = 2;

/**
 * How many agents the command center will hold.
 *
 * A cap rather than an unbounded roster: every agent is persisted, parsed on
 * startup, and rendered, so the number the renderer can create is bounded in the
 * contract instead of by whatever the user has patience for.
 */
export const MAX_AGENTS = 12;

/* ------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* ------------------------------------------------------------------------- */

/**
 * A run's lifecycle.
 *
 * `awaiting-approval` and `paused` are deliberately distinct. The first means a
 * decision is pending and the loop is suspended holding a tool call; the second
 * means no loop is running and resuming requires a fresh turn. Collapsing them
 * would make "the app restarted mid-gate" indistinguishable from "the user is
 * being asked right now".
 */
export const RUN_STATUSES = [
  "idle",
  "planning",
  "acting",
  "awaiting-approval",
  "paused",
  "done",
  "failed",
  "cancelled"
] as const;
export type AgentRunStatus = (typeof RUN_STATUSES)[number];

/** Statuses from which no further work will happen without a new user action. */
export const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = [
  "done",
  "failed",
  "cancelled"
];

export function isTerminalStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export const STEP_KINDS = [
  "thought",
  "tool-call",
  "tool-result",
  "message",
  "error"
] as const;
export type AgentStepKind = (typeof STEP_KINDS)[number];

export const APPROVAL_DECISIONS = ["allow", "deny"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * Providers the app knows how to talk to.
 *
 * The list is the validation surface for every provider-bearing channel, so
 * adding one is a deliberate act rather than something a renderer can assert by
 * sending an unrecognised string. No adapter dispatches yet — the run loop is
 * still scripted — so what a selection buys today is a stored intent and a place
 * to keep that provider's key, not a live connection.
 */
export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "omniroute",
  "openai-compatible",
  "moonshot",
  "qwen",
  "ollama",
  "claude-code",
  "codex",
  "antigravity",
  "gemini-cli",
  "opencode",
  "kimi-code",
  "qwen-code"
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * How the app reaches a provider.
 *
 * `http` posts to an endpoint with a key this app holds. `cli` runs an agentic
 * command-line tool already installed on the machine, which brings its own
 * sign-in — so there is no key for OpenStrawberry to store, and the sensitive
 * setting is which program gets executed rather than where a secret is sent.
 */
export const PROVIDER_TRANSPORTS = ["http", "cli"] as const;
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number];

export const DEFAULT_PROVIDER: ProviderId = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * What the chrome needs to render one provider without a lookup table of its
 * own: how to name it, what to prefill, and what it needs before it can be used.
 */
export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly label: string;
  /** One line for the menu, so a choice explains itself where it is made. */
  readonly summary: string;
  readonly transport: ProviderTransport;
  /**
   * Prefilled when the user picks this provider. Always editable afterwards, and
   * empty for a provider whose models this app cannot know — naming a default
   * there would be a guess presented as a fact.
   */
  readonly defaultModel: string;
  /**
   * True when a model must be named because nothing sensible would happen
   * otherwise. Deliberately not "has no default": a CLI also ships no default
   * here, but it picks its own model, so demanding one would be a barrier the
   * tool does not have.
   */
  readonly requiresModel: boolean;
  /**
   * False for a provider that authenticates itself — a local runtime with
   * nothing to sign in to, or a CLI that already holds its own session. Asking
   * for a key there would invent a barrier and then report it as a fault.
   */
  readonly requiresCredential: boolean;
  /**
   * True when the endpoint is the user's to name. Only the compatible-API entry
   * has one: for a named provider the endpoint is a property of the provider,
   * and letting it be edited would just be somewhere else for a key to be sent.
   */
  readonly requiresBaseUrl: boolean;
  /**
   * The executable a CLI provider expects to find, or null for an HTTP one.
   *
   * A default rather than a fixed value: the tool may be installed somewhere
   * that is not on PATH, and the alternative to letting the user say where is
   * the provider simply not working with no way to find out why.
   */
  readonly defaultCommand: string | null;
  /**
   * Whether this provider's usual models accept images.
   *
   * A prefill for the configuration form, not a fact about the model the user
   * eventually names — which is why the value is editable once a provider is
   * chosen. A preset that serves whatever its operator loaded cannot know, and
   * says so by defaulting to false rather than by guessing true.
   */
  readonly supportsImages: boolean;
  /**
   * The context window to prefill, in tokens, or null when this app has no
   * business claiming one.
   *
   * Null for a CLI, which manages its own context, and for a compatible
   * endpoint, whose window belongs to whatever model its operator loaded.
   */
  readonly defaultContextWindow: number | null;
}

/** Shared shape for the HTTP presets, whose only differences are name and model. */
function httpPreset(
  id: ProviderId,
  label: string,
  defaultModel: string,
  defaultContextWindow: number,
  supportsImages = true
): ProviderDescriptor {
  return {
    id,
    label,
    summary: "Native provider preset with per-agent credentials and model selection.",
    transport: "http",
    defaultModel,
    requiresModel: false,
    requiresCredential: true,
    requiresBaseUrl: false,
    defaultCommand: null,
    supportsImages,
    defaultContextWindow
  };
}

/** Shared shape for a router: one key, and models addressed as `vendor/model`. */
function routerPreset(id: ProviderId, label: string): ProviderDescriptor {
  return {
    id,
    label,
    summary: "Provider API with a per-agent API key and model selection.",
    transport: "http",
    defaultModel: "anthropic/claude-opus-5",
    requiresModel: false,
    requiresCredential: true,
    requiresBaseUrl: false,
    defaultCommand: null,
    supportsImages: true,
    // A router fronts many models with many windows. The prefill is the one its
    // own default model has; anything else the user names is theirs to state.
    defaultContextWindow: 200_000
  };
}

/**
 * Shared shape for an agentic CLI already installed on the machine.
 *
 * No credential: these tools hold their own session, and a second copy of a
 * credential is a second place for it to leak from. No model either — the tool
 * chooses, and overriding it is optional.
 */
function cliPreset(
  id: ProviderId,
  label: string,
  defaultCommand: string
): ProviderDescriptor {
  return {
    id,
    label,
    summary: `Drives the ${label} CLI already installed on this machine.`,
    transport: "cli",
    defaultModel: "",
    requiresModel: false,
    requiresCredential: false,
    requiresBaseUrl: false,
    defaultCommand,
    // A CLI holds its own conversation and manages its own context. Declaring a
    // window here would be this app asserting something it does not control.
    supportsImages: false,
    defaultContextWindow: null
  };
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  httpPreset("anthropic", "Anthropic", DEFAULT_MODEL, 200_000),
  httpPreset("openai", "OpenAI", "gpt-5", 400_000),
  httpPreset("google", "Google", "gemini-2.5-pro", 1_048_576),
  routerPreset("openrouter", "OpenRouter"),
  routerPreset("omniroute", "OmniRoute"),
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    summary:
      "A configurable HTTPS base URL, model ID, and per-agent key for compatible services.",
    transport: "http",
    defaultModel: "",
    requiresModel: true,
    requiresCredential: true,
    requiresBaseUrl: true,
    defaultCommand: null,
    // Whatever the operator loaded. This app knows neither the model nor its
    // window, so both start unclaimed and the user states them.
    supportsImages: false,
    defaultContextWindow: null
  },
  httpPreset("moonshot", "Moonshot AI", "moonshot-v1-32k", 32_768, false),
  httpPreset("qwen", "Qwen", "qwen-max", 32_768),
  {
    id: "ollama",
    label: "Ollama",
    summary: "A local runtime on this machine. No key leaves the device.",
    transport: "http",
    defaultModel: "llama3.1",
    requiresModel: false,
    requiresCredential: false,
    requiresBaseUrl: false,
    defaultCommand: null,
    // A local runtime serves whichever model was pulled. Text is the safe
    // assumption; a vision model is something the user turns on.
    supportsImages: false,
    defaultContextWindow: 128_000
  },
  cliPreset("claude-code", "Claude Code", "claude"),
  cliPreset("codex", "Codex", "codex"),
  cliPreset("antigravity", "Antigravity", "antigravity"),
  cliPreset("gemini-cli", "Gemini CLI", "gemini"),
  cliPreset("opencode", "OpenCode", "opencode"),
  cliPreset("kimi-code", "Kimi Code", "kimi"),
  cliPreset("qwen-code", "Qwen Code", "qwen")
];

/** Null for anything not in the shipped list, so callers must handle the gap. */
export function providerDescriptor(provider: string): ProviderDescriptor | null {
  return PROVIDERS.find((entry) => entry.id === provider) ?? null;
}

/**
 * The model to prefill for a provider.
 *
 * Empty when the provider has no default worth guessing — a compatible service
 * serves whatever its operator loaded, and inventing a name there would put a
 * fabricated model id in front of the user as though the app knew.
 */
export function defaultModelFor(provider: string): string {
  const descriptor = providerDescriptor(provider);
  if (descriptor === null) return DEFAULT_MODEL;
  return descriptor.defaultModel;
}

/**
 * Validates a model name.
 *
 * A router addresses models as `vendor/model`, so the separator is allowed —
 * but the value is interpolated into a request path, so what makes a slash
 * dangerous is banned outright: no traversal, no empty segment, and no leading
 * punctuation. Constrained rather than trusted, as everything crossing IPC is.
 */
export function requireModelId(value: unknown, field: string): string {
  const text = requireString(value, field, MAX_MODEL_LENGTH);

  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(text)) {
    throw new IpcValidationError(
      `${field} must start with a letter or digit and contain only letters, digits, and . _ : / -.`
    );
  }

  // `..` cannot appear even without a slash: a segment is about to be joined
  // into a path, and a rule that depends on where the dots sit is a rule that
  // will be got wrong later.
  if (text.includes("..") || text.includes("//")) {
    throw new IpcValidationError(`${field} must not contain .. or //.`);
  }

  return text;
}

/**
 * Validates a provider endpoint.
 *
 * This is the one setting that decides where an API key gets sent, so it is the
 * strictest thing in this file. HTTPS only, because a key must not cross the
 * wire in the clear. No embedded username or password, because a credential
 * belongs in the encrypted store and not in a field the chrome displays back.
 * No query or fragment, because a base URL is a prefix and anything after it is
 * the adapter's to append.
 */
export function requireBaseUrl(value: unknown, field: string): string {
  const text = requireString(value, field, MAX_BASE_URL_LENGTH).trim();

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new IpcValidationError(`${field} must be a URL.`);
  }

  if (url.protocol !== "https:") {
    throw new IpcValidationError(`${field} must use https, so a key is never sent in the clear.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new IpcValidationError(`${field} must not embed a username or password.`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new IpcValidationError(`${field} must not carry a query or fragment.`);
  }
  if (url.hostname.length === 0) {
    throw new IpcValidationError(`${field} must name a host.`);
  }

  // Normalised, so two spellings of one endpoint cannot read as two endpoints.
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

/**
 * The default command for a CLI provider, or null for an HTTP one.
 */
export function defaultCommandFor(provider: string): string | null {
  return providerDescriptor(provider)?.defaultCommand ?? null;
}

/* ------------------------------------------------------------------------- */
/* Model configuration                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The model settings a route carries beyond "which provider, which model".
 *
 * Every field is nullable, and null always means the same thing: nothing has
 * been said, so take the provider's own answer. That is what makes the shape
 * safe to add to a contract that already has stored data behind it — a profile
 * or a roster written before these existed reads as four unstated settings and
 * behaves exactly as it did.
 *
 * `providerLabel` is a name for the configuration rather than for the provider:
 * two routes can both be "OpenAI-compatible" and point at different machines,
 * and the list of them is unreadable if they are both called that.
 */
export interface ModelTuning {
  /** What to call this configuration. Null takes the provider's own name. */
  readonly providerLabel: string | null;
  /** Whether this route may be sent images. Null takes the preset's answer. */
  readonly supportsImages: boolean | null;
  /** The context window in tokens. Null takes the preset's, which may be none. */
  readonly contextWindow: number | null;
  /** Sampling temperature. Null sends none and leaves the provider's default. */
  readonly temperature: number | null;
}

/** Four unstated settings: what a route with no configuration of its own has. */
export function emptyTuning(): ModelTuning {
  return {
    providerLabel: null,
    supportsImages: null,
    contextWindow: null,
    temperature: null
  };
}

/**
 * A route's tuning with every null resolved against its provider.
 *
 * One function rather than `?? descriptor.x` at each call site, so the form,
 * the summary line, and the request builder cannot disagree about what an
 * unstated setting resolved to.
 */
export function resolveTuning(
  provider: string,
  tuning: ModelTuning
): {
  readonly providerLabel: string;
  readonly supportsImages: boolean;
  readonly contextWindow: number | null;
  readonly temperature: number | null;
} {
  const descriptor = providerDescriptor(provider);

  return {
    providerLabel: tuning.providerLabel ?? descriptor?.label ?? provider,
    supportsImages: tuning.supportsImages ?? descriptor?.supportsImages ?? false,
    contextWindow: tuning.contextWindow ?? descriptor?.defaultContextWindow ?? null,
    // Deliberately no descriptor fallback. An unstated temperature means the
    // request carries none at all, which is not the same as one this app chose.
    temperature: tuning.temperature
  };
}

/**
 * Validates the name or path of a program to execute.
 *
 * This is the value that decides *what runs on the user's machine*, so it is
 * constrained the way the endpoint validator is, and for a bigger reason.
 *
 * The rule that matters most is not in this function: an adapter must spawn this
 * as an argv entry with no shell, because a shell would turn any of the
 * characters below into a second command. The charset here is defence in depth
 * behind that — a program name, a path separator, a drive letter, and the spaces
 * a Windows install directory legitimately contains, and nothing that a shell,
 * were one ever wrongly introduced, would treat as syntax.
 *
 * Arguments are deliberately not accepted. "Command plus flags in one box" is
 * the shape that invites splitting a string on spaces, and that is the bug this
 * refuses to make available.
 */
export function requireCommand(value: unknown, field: string): string {
  const text = requireString(value, field, MAX_COMMAND_LENGTH).trim();
  if (text.length === 0) {
    throw new IpcValidationError(`${field} must not be empty.`);
  }

  if (!/^[A-Za-z0-9 ._:\\/-]+$/u.test(text)) {
    throw new IpcValidationError(
      `${field} must be a program name or path, with no shell characters.`
    );
  }

  // Traversal, and a name that is nothing but punctuation. Both are what an
  // attempt to reach somewhere other than the named program looks like.
  if (text.includes("..")) {
    throw new IpcValidationError(`${field} must not contain ...`);
  }
  if (!/[A-Za-z0-9]/u.test(text)) {
    throw new IpcValidationError(`${field} must name a program.`);
  }

  return text;
}

/**
 * Whether a credential can be stored, and when it cannot, why.
 *
 * Three states rather than a boolean because the two failure modes deserve
 * different words. `no-keyring` is a local condition the user can fix — install
 * or unlock a keyring — while `unavailable` is a property of the system they are
 * on. Telling someone "this system offers no encryption" when the real answer is
 * "your keyring is not running" sends them looking for the fault in the app.
 */
export const ENCRYPTION_STATES = ["available", "no-keyring", "unavailable"] as const;
export type EncryptionState = (typeof ENCRYPTION_STATES)[number];

/* ------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* ------------------------------------------------------------------------- */

export interface AgentStep {
  readonly id: string;
  readonly kind: AgentStepKind;
  /** One-line display text, already trimmed for presentation. */
  readonly label: string;
  /** Expandable detail, bounded. Never raw page HTML and never a credential. */
  readonly detail: string | null;
  /** The tab this step touched, so the chrome can offer to reveal it. */
  readonly tabId: string | null;
  readonly at: number;
}

/**
 * A side effect the run wants to perform and is waiting to be allowed.
 *
 * `summary` is written for a human deciding in one glance, and `reason` names
 * which rule caused the gate to fire — a gate the user cannot understand is one
 * they will click through.
 */
export interface ApprovalRequest {
  readonly id: string;
  readonly runId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly reason: string;
  readonly tabId: string | null;
}

export interface AgentRunState {
  readonly id: string;
  readonly companionId: string;
  readonly task: string;
  readonly status: AgentRunStatus;
  readonly steps: readonly AgentStep[];
  readonly pendingApproval: ApprovalRequest | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface AgentCompanion {
  readonly id: string;
  readonly name: string;
  /** Role slug, used to rank which prompt suggestions to surface. */
  readonly role: string;
  readonly skillPaths: readonly string[];
  /**
   * Which provider this agent talks to, or null to follow the orchestrator.
   *
   * Null is a real state rather than a copy of the orchestrator's value: an
   * agent that follows moves when the orchestrator moves, and an agent that was
   * pinned stays pinned. Collapsing the two at write time would silently turn
   * every agent into a pinned one the first time the roster was saved.
   */
  readonly provider: ProviderId | null;
  /** Null takes the provider's default model. */
  readonly model: string | null;
  /**
   * The endpoint, for a provider whose endpoint is the user's to name. Null for
   * every preset, where the endpoint belongs to the provider rather than to the
   * agent.
   */
  readonly baseUrl: string | null;
  /**
   * The program to run, for a CLI provider whose tool is not where the preset
   * expects it. Null takes the provider's default command.
   */
  readonly command: string | null;
  /**
   * This agent's model settings, all four of which mean "take the provider's
   * answer" when null. Ignored while `provider` is null: an agent that follows
   * the orchestrator follows its tuning too, rather than keeping half of one.
   */
  readonly tuning: ModelTuning;
}

/** What the chrome may know about one provider: whether a shared key is stored. */
export interface ProviderStatus extends ProviderDescriptor {
  /**
   * Whether a stored credential actually decrypts. Deliberately not "is usable":
   * a local provider needs no key and is usable with this false, and the chrome
   * is the place that combines the two into a readiness the user sees.
   */
  readonly configured: boolean;
}

/**
 * That one agent holds its own key for one provider — never the key itself.
 *
 * Reported as a pair rather than a flag on the agent, because a key is stored
 * against the provider it authenticates. An agent moved to a different provider
 * is not carrying its old key over to it, and this shape makes that impossible
 * to express rather than merely unlikely.
 */
export interface AgentCredentialStatus {
  readonly companionId: string;
  readonly provider: ProviderId;
}

/**
 * What the chrome may know about credentials: that one exists, not what it is.
 *
 * `provider` and `model` are the orchestrator's — the settings a run falls back
 * to when an agent has not been pinned to something else.
 *
 * `encryption` is surfaced because OpenStrawberry refuses to store a key at all
 * when the OS cannot protect one, rather than falling back to plaintext. The
 * panel needs to explain that — and explain which of the two reasons applies —
 * rather than appear broken.
 */
export interface AgentConfigStatus {
  readonly configured: boolean;
  readonly provider: string;
  readonly model: string;
  /** The orchestrator's endpoint, when its provider is one the user names. */
  readonly baseUrl: string | null;
  /** The orchestrator's program, when its provider is a local CLI. */
  readonly command: string | null;
  /** The orchestrator's model settings — the ones a following agent inherits. */
  readonly tuning: ModelTuning;
  readonly encryption: EncryptionState;
  /** Every shipped provider, so the command center needs no table of its own. */
  readonly providers: readonly ProviderStatus[];
  /** Which agents hold a key of their own, and for which provider. */
  readonly agentCredentials: readonly AgentCredentialStatus[];
}

/** Whether this agent authenticates with its own key rather than the shared one. */
export function hasOwnCredential(
  config: AgentConfigStatus,
  companionId: string,
  provider: string
): boolean {
  return config.agentCredentials.some(
    (entry) => entry.companionId === companionId && entry.provider === provider
  );
}

/** Discovery metadata for one skill. The body is never included here. */
export interface AgentSkillSummary {
  readonly path: string;
  readonly name: string;
  readonly description: string;
  readonly displayName: string;
  readonly tags: readonly string[];
}

export interface AgentSnapshot {
  readonly companions: readonly AgentCompanion[];
  /** Which agent the composer talks to. Null before any agent exists. */
  readonly activeCompanionId: string | null;
  readonly runs: readonly AgentRunState[];
  readonly activeRunId: string | null;
  readonly config: AgentConfigStatus;
}

/* ------------------------------------------------------------------------- */
/* Snapshot helpers                                                           */
/* ------------------------------------------------------------------------- */

/** Trims a step's detail to the contract bound rather than rejecting it. */
export function boundStepDetail(detail: string | null): string | null {
  if (detail === null || detail.length === 0) return null;
  if (detail.length <= MAX_STEP_DETAIL_LENGTH) return detail;
  return detail.slice(0, MAX_STEP_DETAIL_LENGTH);
}

/** Keeps the newest steps. A long run loses its opening, never its present. */
export function boundSteps(steps: readonly AgentStep[]): readonly AgentStep[] {
  if (steps.length <= MAX_STEPS_RETAINED) return steps;
  return steps.slice(steps.length - MAX_STEPS_RETAINED);
}

/** Keeps the newest runs, and never drops one that still needs the user. */
export function boundRuns(runs: readonly AgentRunState[]): readonly AgentRunState[] {
  if (runs.length <= MAX_RUNS_RETAINED) return runs;

  // A run holding a pending approval is the one thing the user must still see,
  // so it survives eviction even if it is old.
  const pending = runs.filter((run) => run.pendingApproval !== null);
  const rest = runs.filter((run) => run.pendingApproval === null);
  const keep = Math.max(0, MAX_RUNS_RETAINED - pending.length);

  const trimmed = rest.slice(rest.length - keep);
  return runs.filter((run) => pending.includes(run) || trimmed.includes(run));
}

export function findRun(
  snapshot: AgentSnapshot,
  runId: string
): AgentRunState | null {
  return snapshot.runs.find((run) => run.id === runId) ?? null;
}

export function activeRun(snapshot: AgentSnapshot): AgentRunState | null {
  if (snapshot.activeRunId === null) return null;
  return findRun(snapshot, snapshot.activeRunId);
}

/** The one request the chrome should be showing, if any. */
export function pendingApproval(snapshot: AgentSnapshot): ApprovalRequest | null {
  for (const run of snapshot.runs) {
    if (run.pendingApproval !== null) return run.pendingApproval;
  }
  return null;
}

export function emptyConfigStatus(): AgentConfigStatus {
  return {
    configured: false,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    baseUrl: null,
    command: null,
    tuning: emptyTuning(),
    encryption: "unavailable",
    providers: PROVIDERS.map((descriptor) => ({ ...descriptor, configured: false })),
    agentCredentials: []
  };
}

export function emptySnapshot(): AgentSnapshot {
  return {
    companions: [],
    activeCompanionId: null,
    runs: [],
    activeRunId: null,
    config: emptyConfigStatus()
  };
}

/** The agent the composer is addressing: the selected one, else the first. */
export function activeCompanion(snapshot: AgentSnapshot): AgentCompanion | null {
  if (snapshot.activeCompanionId !== null) {
    const selected = snapshot.companions.find(
      (companion) => companion.id === snapshot.activeCompanionId
    );
    if (selected !== undefined) return selected;
  }
  return snapshot.companions.at(0) ?? null;
}

/**
 * The provider and model a run for this agent would actually use.
 *
 * One function rather than the same three-line fallback at every call site: the
 * chrome shows it, and the runtime will dispatch on it, and those two must not
 * be able to disagree about what "follows the orchestrator" resolved to.
 */
export function resolvedProvider(
  companion: AgentCompanion | null,
  config: AgentConfigStatus
): {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string | null;
  /** The program that would run, for a CLI provider. Null for an HTTP one. */
  readonly command: string | null;
  /**
   * The model settings this route would run under, with every unstated one
   * already resolved against its provider. A caller building a request reads
   * this rather than reaching for the descriptor itself.
   */
  readonly tuning: ReturnType<typeof resolveTuning>;
  readonly inherited: boolean;
} {
  if (companion === null || companion.provider === null) {
    return {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      command: config.command ?? defaultCommandFor(config.provider),
      // An agent that follows the orchestrator follows all of it. Mixing its own
      // temperature into an inherited route would make "follows" mean two things.
      tuning: resolveTuning(config.provider, config.tuning),
      inherited: true
    };
  }

  return {
    provider: companion.provider,
    model: companion.model ?? defaultModelFor(companion.provider),
    baseUrl: companion.baseUrl,
    command: companion.command ?? defaultCommandFor(companion.provider),
    tuning: resolveTuning(companion.provider, companion.tuning),
    inherited: false
  };
}

/* ------------------------------------------------------------------------- */
/* Provider profile                                                           */
/* ------------------------------------------------------------------------- */

export const AGENT_PROFILE_VERSION = 1;

/**
 * Which provider and model the orchestrator talks to.
 *
 * This is the fallback every agent inherits until it is pinned to something
 * else, which is why it lives with the app's configuration rather than in the
 * roster: losing the roster must not leave the orchestrator unconfigured.
 *
 * Deliberately separate from the credential, and stored in its own file. The
 * profile is not a secret — it is worth reading, migrating, and showing — while
 * the key is encrypted and never read back out to the chrome. Keeping them apart
 * means the thing you inspect is never the thing you must protect.
 */
export interface AgentProfile {
  readonly version: number;
  readonly provider: ProviderId;
  readonly model: string;
  /** Null for every provider whose endpoint is not the user's to name. */
  readonly baseUrl: string | null;
  /** Null unless the provider is a CLI whose program is somewhere unusual. */
  readonly command: string | null;
  /**
   * The orchestrator's model settings.
   *
   * Stored inside the profile rather than as four more top-level keys, so a file
   * written before they existed parses into `emptyTuning()` in one place instead
   * of four — and so the version number does not have to move for a change that
   * loses nothing.
   */
  readonly tuning: ModelTuning;
}

export function emptyAgentProfile(): AgentProfile {
  return {
    version: AGENT_PROFILE_VERSION,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    baseUrl: null,
    command: null,
    tuning: emptyTuning()
  };
}

/**
 * Reads model settings out of a stored object, tolerating every absence.
 *
 * Used for both the profile file and the roster file. Anything malformed
 * degrades to unstated rather than throwing, because the alternative — a
 * hand-edited temperature wedging the orchestrator on startup — is worse than
 * quietly falling back to the provider's own default.
 */
export function parseModelTuning(raw: unknown, field: string): ModelTuning {
  if (raw === null || raw === undefined) return emptyTuning();

  const root = requirePlainObject(raw, field);
  const label = root["providerLabel"];
  const images = root["supportsImages"];
  const contextWindow = root["contextWindow"];
  const temperature = root["temperature"];

  return {
    providerLabel:
      typeof label === "string" && label.trim().length > 0
        ? requireString(label.trim(), `${field} name`, MAX_PROVIDER_LABEL_LENGTH)
        : null,
    supportsImages: typeof images === "boolean" ? images : null,
    contextWindow:
      typeof contextWindow === "number"
        ? requireInteger(
            contextWindow,
            `${field} context window`,
            MIN_CONTEXT_WINDOW,
            MAX_CONTEXT_WINDOW
          )
        : null,
    temperature:
      typeof temperature === "number" ? requireTemperature(temperature, field) : null
  };
}

/**
 * Validates a temperature.
 *
 * Rejects rather than clamps. A clamped value is one the user asked for and did
 * not get, with nothing on screen saying so; a rejection reaches the form, which
 * is where the number was typed.
 */
export function requireTemperature(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new IpcValidationError(`${field} temperature must be a number.`);
  }
  if (raw < 0 || raw > MAX_TEMPERATURE) {
    throw new IpcValidationError(
      `${field} temperature must be between 0 and ${MAX_TEMPERATURE}.`
    );
  }
  // Two decimals is the granularity every provider here documents, and rounding
  // keeps a float that arrived as 0.30000000000000004 from being stored as one.
  return Math.round(raw * 100) / 100;
}

/**
 * Parses a profile file written by an earlier run.
 *
 * Anything unrecognised falls back to the default rather than throwing, so a
 * hand-edited file degrades to "the shipped provider" instead of wedging the
 * agent runtime.
 */
export function parseAgentProfile(raw: unknown): AgentProfile {
  try {
    const root = requirePlainObject(raw, "Agent profile");
    if (
      requireInteger(root["version"], "Agent profile version", 1, 1_000) !==
      AGENT_PROFILE_VERSION
    ) {
      return emptyAgentProfile();
    }

    const baseUrl = root["baseUrl"];
    const command = root["command"];
    const model = root["model"];
    const provider = requireOneOf(
      root["provider"],
      PROVIDER_IDS,
      "Agent profile provider"
    );

    return {
      version: AGENT_PROFILE_VERSION,
      provider,
      // Constrained rather than free text: the model name is interpolated into
      // a provider request. Absent falls back the same way the IPC payload does
      // — to the provider's default, which is empty exactly for a CLI, since a
      // CLI picks its own.
      model: parseModel(model, provider, "Agent profile model"),
      // Absent is the normal case — only a compatible endpoint has one — and a
      // file written before endpoints existed reads as a preset, which it was.
      baseUrl:
        typeof baseUrl === "string"
          ? requireBaseUrl(baseUrl, "Agent profile base URL")
          : null,
      // A hand-edited command names a program that would be executed, so a file
      // is no more trusted here than the renderer is.
      command:
        typeof command === "string"
          ? requireCommand(command, "Agent profile command")
          : null,
      // Absent for every file written before model settings existed, which reads
      // as four unstated settings — exactly what that file meant.
      tuning: parseModelTuning(root["tuning"], "Agent profile")
    };
  } catch {
    return emptyAgentProfile();
  }
}

/* ------------------------------------------------------------------------- */
/* Persisted state                                                            */
/* ------------------------------------------------------------------------- */

export const AGENT_STATE_VERSION = 1;

export interface PersistedAgentState {
  readonly version: number;
  readonly companions: readonly AgentCompanion[];
  readonly activeCompanionId: string | null;
  readonly runs: readonly AgentRunState[];
}

/**
 * A status as it must appear after a restart.
 *
 * Nothing is running once the process has gone, so every non-terminal status
 * becomes `paused`. This is what stops a restart from crossing an approval
 * gate: a run suspended mid-decision comes back needing the user again rather
 * than resuming the action it was holding.
 */
export function restoredStatus(status: AgentRunStatus): AgentRunStatus {
  return isTerminalStatus(status) ? status : "paused";
}

export function emptyAgentState(): PersistedAgentState {
  return {
    version: AGENT_STATE_VERSION,
    companions: [],
    activeCompanionId: null,
    runs: []
  };
}

/**
 * Step kinds whose detail is dropped before anything is written to disk.
 *
 * These are the ones an agent's browser access produces, and their detail is
 * the one thing in a run that can be a page's own text: a `read_page` result is
 * the article, a `page_links` result is every address on it, and a `snapshot` is
 * every control and field value on it. Keeping that in live state is what lets
 * the panel show a user what their agent actually saw; writing it to
 * `agents.json` would put the contents of a signed-in page into plain JSON on
 * disk, where it would outlive the run, the window, and any memory of having
 * asked.
 *
 * `error` is on the list for the same reason and only that reason: a failed
 * tool result is the one error whose body is not this application's own wording.
 * Every other error step already carries no detail at all, so nothing is lost by
 * refusing to write one.
 *
 * The label survives, so a restored run still says which tools were used and
 * on what. Only the body goes.
 */
const TRANSIENT_DETAIL_KINDS: readonly AgentStepKind[] = ["tool-call", "tool-result", "error"];

/**
 * Reduces live state to the bounded subset worth persisting.
 *
 * Note what has no field here and so cannot be written: a credential, a
 * provider base URL, a page's contents, or an absolute local path.
 */
export function toPersistedAgentState(snapshot: AgentSnapshot): PersistedAgentState {
  return {
    version: AGENT_STATE_VERSION,
    companions: snapshot.companions,
    activeCompanionId: snapshot.activeCompanionId,
    runs: boundRuns(snapshot.runs).map((run) => ({
      ...run,
      status: restoredStatus(run.status),
      steps: boundSteps(run.steps).map((step) =>
        TRANSIENT_DETAIL_KINDS.includes(step.kind) ? { ...step, detail: null } : step
      )
    }))
  };
}

function parseStep(raw: unknown): AgentStep {
  const step = requirePlainObject(raw, "Agent step");
  const detail = step["detail"];
  const tabId = step["tabId"];

  return {
    id: requireIdentifier(step["id"], "Agent step id"),
    kind: requireOneOf(step["kind"], STEP_KINDS, "Agent step kind"),
    label: requireString(step["label"], "Agent step label", MAX_TEXT_LENGTH),
    detail:
      typeof detail === "string" && detail.length > 0
        ? boundStepDetail(detail)
        : null,
    tabId: typeof tabId === "string" ? requireIdentifier(tabId, "Agent step tab") : null,
    at: requireInteger(step["at"], "Agent step timestamp", 0, MAX_TIMESTAMP)
  };
}

function parseApproval(raw: unknown, runId: string): ApprovalRequest {
  const approval = requirePlainObject(raw, "Approval request");
  const tabId = approval["tabId"];

  return {
    id: requireIdentifier(approval["id"], "Approval id"),
    // A stored approval that names a different run is corrupt, so the run's own
    // id wins rather than being trusted from the file.
    runId,
    toolName: requireIdentifier(approval["toolName"], "Approval tool"),
    summary: requireString(approval["summary"], "Approval summary", MAX_TEXT_LENGTH),
    reason: requireString(approval["reason"], "Approval reason", MAX_TEXT_LENGTH),
    tabId: typeof tabId === "string" ? requireIdentifier(tabId, "Approval tab") : null
  };
}

function parseCompanion(raw: unknown): AgentCompanion {
  const companion = requirePlainObject(raw, "Companion");
  const rawSkills = requireArray(companion["skillPaths"], "Companion skills");
  const provider = companion["provider"];
  const model = companion["model"];
  const baseUrl = companion["baseUrl"];
  const command = companion["command"];

  return {
    id: requireIdentifier(companion["id"], "Companion id"),
    name: requireString(companion["name"], "Companion name", MAX_AGENT_NAME_LENGTH),
    role: requireIdentifier(companion["role"], "Companion role"),
    skillPaths: rawSkills.map((entry) =>
      requireString(entry, "Companion skill path", MAX_IDENTIFIER_LENGTH)
    ),
    // Absent means "follows the orchestrator", which is both the default for a
    // new agent and what a file written before pinning existed should become.
    provider:
      typeof provider === "string"
        ? requireOneOf(provider, PROVIDER_IDS, "Companion provider")
        : null,
    model: typeof model === "string" ? requireModelId(model, "Companion model") : null,
    baseUrl:
      typeof baseUrl === "string"
        ? requireBaseUrl(baseUrl, "Companion base URL")
        : null,
    // A stored command names a program that would be executed, so a file on disk
    // is validated exactly as strictly as an IPC payload.
    command:
      typeof command === "string" ? requireCommand(command, "Companion command") : null,
    tuning: parseModelTuning(companion["tuning"], "Companion")
  };
}

function parseRun(raw: unknown): AgentRunState {
  const run = requirePlainObject(raw, "Agent run");
  const id = requireIdentifier(run["id"], "Agent run id");
  const rawSteps = requireArray(run["steps"], "Agent run steps", MAX_STEPS_RETAINED);
  const approval = run["pendingApproval"];
  const endedAt = run["endedAt"];
  const status = restoredStatus(
    requireOneOf(run["status"], RUN_STATUSES, "Agent run status")
  );

  return {
    id,
    companionId: requireIdentifier(run["companionId"], "Agent run companion"),
    task: requireString(run["task"], "Agent run task", MAX_TASK_LENGTH),
    status,
    steps: boundSteps(rawSteps.map(parseStep)),
    pendingApproval:
      approval === null || approval === undefined ? null : parseApproval(approval, id),
    startedAt: requireInteger(run["startedAt"], "Agent run start", 0, MAX_TIMESTAMP),
    endedAt:
      typeof endedAt === "number"
        ? requireInteger(endedAt, "Agent run end", 0, MAX_TIMESTAMP)
        : null
  };
}

/**
 * Parses a state file written by an earlier run.
 *
 * The file is on disk and could have been edited, so it is treated as
 * untrusted. A corrupt file yields empty state instead of throwing, so a bad
 * file can never wedge startup — the same posture as `parsePersistedSession`.
 */
export function parsePersistedAgentState(raw: unknown): PersistedAgentState {
  try {
    const root = requirePlainObject(raw, "Agent state");
    if (
      requireInteger(root["version"], "Agent state version", 1, 1_000) !==
      AGENT_STATE_VERSION
    ) {
      return emptyAgentState();
    }

    const rawCompanions = requireArray(root["companions"], "Agent companions", MAX_AGENTS);
    const rawRuns = requireArray(root["runs"], "Agent runs", MAX_RUNS_RETAINED);
    const rawActive = root["activeCompanionId"];

    const companions: AgentCompanion[] = [];
    const seenCompanions = new Set<string>();
    for (const entry of rawCompanions) {
      const companion = parseCompanion(entry);
      if (seenCompanions.has(companion.id)) continue;
      seenCompanions.add(companion.id);
      companions.push(companion);
    }

    // A selection naming an agent that did not survive validation is stale, and
    // `activeCompanion` falls back to the first agent rather than to nothing.
    const activeCompanionId =
      typeof rawActive === "string" &&
      seenCompanions.has(requireIdentifier(rawActive, "Active companion"))
        ? rawActive
        : null;

    const runs: AgentRunState[] = [];
    const seenRuns = new Set<string>();
    for (const entry of rawRuns) {
      const run = parseRun(entry);
      if (seenRuns.has(run.id)) continue;
      // A run whose companion did not survive validation has nothing to resume
      // against, so it is dropped rather than left dangling.
      if (!seenCompanions.has(run.companionId)) continue;
      seenRuns.add(run.id);
      runs.push(run);
    }

    return { version: AGENT_STATE_VERSION, companions, activeCompanionId, runs };
  } catch {
    return emptyAgentState();
  }
}

/* ------------------------------------------------------------------------- */
/* IPC payload parsers                                                        */
/* ------------------------------------------------------------------------- */

export interface StartRunPayload {
  readonly companionId: string;
  readonly task: string;
  readonly tabIds: readonly string[];
}

/**
 * Credential shapes, for scrubbing text a user typed.
 *
 * Deliberately anchored on well-known prefixes rather than on entropy. A general
 * "looks like a secret" heuristic mangles ordinary text - commit hashes, base64
 * payloads, long identifiers - and a task that silently loses part of itself is
 * worse than one that keeps a key the user chose to paste. Every pattern here
 * names a specific issuer's format.
 *
 * Written with escapes so the character classes stay reviewable.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  // OpenAI and Anthropic, including project- and org-scoped variants.
  new RegExp("sk-(?:ant-|proj-|org-)?[A-Za-z0-9_-]{16,}", "gu"),
  // GitHub personal access tokens, classic and fine-grained.
  new RegExp("gh[pousr]_[A-Za-z0-9]{16,}", "gu"),
  new RegExp("github_pat_[A-Za-z0-9_]{20,}", "gu"),
  // AWS access key ids.
  new RegExp("AKIA[0-9A-Z]{16}", "gu"),
  // Slack tokens.
  new RegExp("xox[baprs]-[A-Za-z0-9-]{10,}", "gu"),
  // Google API keys.
  new RegExp("AIza[A-Za-z0-9_-]{30,}", "gu"),
  // A bearer token in a header the user pasted whole.
  new RegExp("[Bb]earer\\s+[A-Za-z0-9._~+/-]{20,}={0,2}", "gu")
];

export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Removes credential-shaped tokens from text before it is stored.
 *
 * A user pasting a key into the composer - to ask an agent to use it, or by
 * accident - would otherwise have it written verbatim into the run log, which is
 * ordinary JSON on disk that nothing encrypts. The store exists precisely so a
 * key is never in a file like that.
 *
 * This is a mitigation, not a guarantee. A key in a format nothing here
 * recognises still passes through, which is why the credential store, and not
 * this function, is the actual answer to "where does a key live".
 */
export function scrubCredentials(text: string): string {
  let scrubbed = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return scrubbed;
}

export function parseStartRunPayload(raw: unknown): StartRunPayload {
  const root = requirePlainObject(raw, "Start run payload");
  const rawTabIds = requireArray(root["tabIds"], "Context tabs", MAX_CONTEXT_TABS);

  const tabIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawTabIds) {
    const tabId = requireIdentifier(entry, "Context tab");
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    tabIds.push(tabId);
  }

  return {
    companionId: requireIdentifier(root["companionId"], "Companion ID"),
    // Scrubbed at the boundary, so the manager never holds the raw text and no
    // later code has to remember to.
    task: scrubCredentials(requireString(root["task"], "Task", MAX_TASK_LENGTH)),
    tabIds
  };
}

export interface RunIdPayload {
  readonly runId: string;
}

export function parseRunIdPayload(raw: unknown): RunIdPayload {
  const root = requirePlainObject(raw, "Run payload");
  return { runId: requireIdentifier(root["runId"], "Run ID") };
}

export interface ResolveApprovalPayload {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
}

export function parseResolveApprovalPayload(raw: unknown): ResolveApprovalPayload {
  const root = requirePlainObject(raw, "Approval payload");
  return {
    approvalId: requireIdentifier(root["approvalId"], "Approval ID"),
    decision: requireOneOf(root["decision"], APPROVAL_DECISIONS, "Decision")
  };
}

/**
 * Which key is being addressed: a provider's shared one, or one agent's own.
 *
 * `companionId` null is the shared key — the one an agent falls back to when it
 * has none of its own. Two scopes rather than two channels, so the rule "an
 * agent key beats the shared key" is stated once, in the store.
 */
export interface CredentialScopePayload {
  readonly provider: ProviderId;
  readonly companionId: string | null;
}

export function parseCredentialScopePayload(raw: unknown): CredentialScopePayload {
  const root = requirePlainObject(raw, "Credential scope");
  const companionId = root["companionId"];

  return {
    provider: requireOneOf(root["provider"], PROVIDER_IDS, "Provider"),
    companionId:
      companionId === null || companionId === undefined
        ? null
        : requireIdentifier(companionId, "Agent ID")
  };
}

export interface SetCredentialPayload extends CredentialScopePayload {
  readonly key: string;
}

/**
 * Validates a credential write.
 *
 * The value is bounded and its shape checked, but it is never echoed: the
 * validators in `ipc-validation.ts` name the field and the expectation only, so
 * a rejected key cannot be smuggled into a log line through an error message.
 */
export function parseSetCredentialPayload(raw: unknown): SetCredentialPayload {
  const root = requirePlainObject(raw, "Credential payload");
  return {
    ...parseCredentialScopePayload(root),
    key: requireString(root["key"], "Credential", MAX_CREDENTIAL_LENGTH)
  };
}

export interface SetOrchestratorPayload {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  readonly command: string | null;
  readonly tuning: ModelTuning;
}

export function parseSetOrchestratorPayload(raw: unknown): SetOrchestratorPayload {
  const root = requirePlainObject(raw, "Orchestrator payload");
  const provider = requireOneOf(root["provider"], PROVIDER_IDS, "Provider");

  return {
    provider,
    model: parseModel(root["model"], provider, "Model"),
    baseUrl: parseEndpoint(root["baseUrl"], provider, "Base URL"),
    command: parseProgram(root["command"], provider, "Command"),
    tuning: parseTuningPayload(root["tuning"], provider, "Orchestrator")
  };
}

/**
 * Reads model settings from a renderer, against the provider they belong to.
 *
 * Stricter than `parseModelTuning`, which forgives a file: a malformed number
 * from the chrome is a bug in the chrome, and swallowing it would leave the user
 * with a temperature they typed, a form that accepted it, and a request that
 * never carried it.
 *
 * The settings a provider cannot use are dropped rather than stored. A CLI runs
 * a program that manages its own sampling, so a temperature saved against one
 * would be a setting sitting in config with nothing that reads it.
 */
function parseTuningPayload(
  raw: unknown,
  provider: ProviderId,
  field: string
): ModelTuning {
  if (raw === null || raw === undefined) return emptyTuning();

  const root = requirePlainObject(raw, `${field} model configuration`);
  const label = root["providerLabel"];
  const images = root["supportsImages"];
  const contextWindow = root["contextWindow"];
  const temperature = root["temperature"];
  const isCli = providerDescriptor(provider)?.transport === "cli";

  const named =
    label === null || label === undefined || label === ""
      ? null
      : requireString(
          String(label).trim(),
          `${field} provider name`,
          MAX_PROVIDER_LABEL_LENGTH
        );

  if (isCli) {
    // A name still means something for a CLI — it is what the route is called in
    // a list. Nothing else here does.
    return { ...emptyTuning(), providerLabel: named === "" ? null : named };
  }

  return {
    providerLabel: named === "" ? null : named,
    supportsImages:
      images === null || images === undefined
        ? null
        : requireBoolean(images, `${field} image support`),
    contextWindow:
      contextWindow === null || contextWindow === undefined || contextWindow === ""
        ? null
        : requireInteger(
            contextWindow,
            `${field} context window`,
            MIN_CONTEXT_WINDOW,
            MAX_CONTEXT_WINDOW
          ),
    temperature:
      temperature === null || temperature === undefined || temperature === ""
        ? null
        : requireTemperature(temperature, field)
  };
}

/** A boolean and nothing coercible to one, matching every other validator here. */
function requireBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") {
    throw new IpcValidationError(`${field} must be true or false.`);
  }
  return raw;
}

/**
 * Reads a model against the provider it belongs to.
 *
 * An empty model falls back to the provider's default, and is only an error
 * where there is no default and the provider cannot choose for itself. A CLI
 * can, so an empty model there is the ordinary case rather than a gap.
 */
function parseModel(raw: unknown, provider: ProviderId, field: string): string {
  if (raw === null || raw === undefined || raw === "") {
    const fallback = defaultModelFor(provider);
    if (fallback.length === 0 && providerDescriptor(provider)?.requiresModel === true) {
      throw new IpcValidationError(`${field} is required for this provider.`);
    }
    return fallback;
  }

  return requireModelId(raw, field);
}

/**
 * Reads a program name against the provider it belongs to.
 *
 * Null for anything that is not a CLI, however hard the renderer insists: a
 * stored program for an HTTP provider would be an executable path sitting in
 * config with nothing that reads it, waiting for a future adapter to find it.
 * Null for a CLI too when none was given — that is "use the preset's command".
 */
function parseProgram(
  raw: unknown,
  provider: ProviderId,
  field: string
): string | null {
  if (providerDescriptor(provider)?.transport !== "cli") return null;
  if (raw === null || raw === undefined || raw === "") return null;
  return requireCommand(raw, field);
}

/**
 * Reads an endpoint against the provider it belongs to.
 *
 * A provider that needs one must have one, and a provider that does not gets
 * null however hard the renderer insists. Storing an endpoint for a preset would
 * leave a field that looks like it redirects where the key goes and does not —
 * the worst kind of security setting.
 */
function parseEndpoint(
  raw: unknown,
  provider: ProviderId,
  field: string
): string | null {
  const needsBaseUrl = providerDescriptor(provider)?.requiresBaseUrl === true;
  if (!needsBaseUrl) return null;

  if (raw === null || raw === undefined) {
    throw new IpcValidationError(`${field} is required for this provider.`);
  }
  return requireBaseUrl(raw, field);
}

/**
 * The editable half of an agent.
 *
 * The id is not here: creation mints one in the trusted process, and an update
 * names one separately. A renderer therefore cannot choose an agent's handle,
 * which is what keeps ids app-minted the way `requireIdentifier` assumes.
 */
export interface CompanionDraftPayload {
  readonly name: string;
  readonly role: string;
  /** Null follows the orchestrator. */
  readonly provider: ProviderId | null;
  /** Null takes the provider's default model. */
  readonly model: string | null;
  /** Set only for a provider whose endpoint the user names. */
  readonly baseUrl: string | null;
  /** Set only for a CLI provider whose program is somewhere unusual. */
  readonly command: string | null;
  /** Unstated throughout for an agent that follows the orchestrator. */
  readonly tuning: ModelTuning;
}

function parseCompanionDraft(root: Record<string, unknown>): CompanionDraftPayload {
  const rawProvider = root["provider"];
  const model = root["model"];

  const provider =
    rawProvider === null || rawProvider === undefined
      ? null
      : requireOneOf(rawProvider, PROVIDER_IDS, "Agent provider");

  const parsedModel =
    model === null || model === undefined || model === ""
      ? null
      : requireModelId(model, "Agent model");

  // A provider with no default and no ability to choose for itself must be told
  // which model to use. A CLI chooses, so it is exempt.
  if (
    provider !== null &&
    parsedModel === null &&
    providerDescriptor(provider)?.requiresModel === true
  ) {
    throw new IpcValidationError("Agent model is required for this provider.");
  }

  return {
    name: requireString(root["name"], "Agent name", MAX_AGENT_NAME_LENGTH),
    // A role is a slug the chrome derives from what the user typed, so it is
    // validated as an identifier here rather than accepted as free text.
    role: requireIdentifier(root["role"], "Agent role"),
    provider,
    model: parsedModel,
    baseUrl:
      provider === null
        ? null
        : parseEndpoint(root["baseUrl"], provider, "Agent base URL"),
    command:
      provider === null ? null : parseProgram(root["command"], provider, "Agent command"),
    // An agent that follows the orchestrator inherits its settings whole, so it
    // stores none of its own — the same rule that already drops its endpoint.
    tuning:
      provider === null ? emptyTuning() : parseTuningPayload(root["tuning"], provider, "Agent")
  };
}

export function parseCreateCompanionPayload(raw: unknown): CompanionDraftPayload {
  return parseCompanionDraft(requirePlainObject(raw, "Agent payload"));
}

export interface UpdateCompanionPayload extends CompanionDraftPayload {
  readonly companionId: string;
}

export function parseUpdateCompanionPayload(raw: unknown): UpdateCompanionPayload {
  const root = requirePlainObject(raw, "Agent payload");
  return {
    companionId: requireIdentifier(root["companionId"], "Agent ID"),
    ...parseCompanionDraft(root)
  };
}

/**
 * A configuration the renderer wants tried before it is applied.
 *
 * Shaped like a route rather than like an agent, because that is what is being
 * tested: the form's current provider, model, endpoint, and program, plus which
 * scope's key should authenticate the attempt. There is no key on this type, and
 * there is no channel that would return one.
 */
export interface ProviderTestPayload {
  readonly provider: ProviderId;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly command: string | null;
  readonly tuning: ModelTuning;
  /** Whose key to try: one agent's own, or null for the shared one. */
  readonly companionId: string | null;
}

export function parseProviderTestPayload(raw: unknown): ProviderTestPayload {
  const root = requirePlainObject(raw, "Provider test payload");
  const provider = requireOneOf(root["provider"], PROVIDER_IDS, "Provider");
  const model = root["model"];
  const companionId = root["companionId"];

  return {
    provider,
    // Blank is "the provider's default", exactly as it is when saving — a test
    // must exercise the route the form would produce, not a stricter one.
    model:
      model === null || model === undefined || model === ""
        ? null
        : requireModelId(model, "Model"),
    baseUrl: parseEndpoint(root["baseUrl"], provider, "Base URL"),
    command: parseProgram(root["command"], provider, "Command"),
    tuning: parseTuningPayload(root["tuning"], provider, "Provider test"),
    companionId:
      companionId === null || companionId === undefined
        ? null
        : requireIdentifier(companionId, "Agent ID")
  };
}

export interface CompanionIdPayload {
  readonly companionId: string;
}

export function parseCompanionIdPayload(raw: unknown): CompanionIdPayload {
  const root = requirePlainObject(raw, "Agent payload");
  return { companionId: requireIdentifier(root["companionId"], "Agent ID") };
}

/** Re-exported so callers do not need to reach into the validation module. */
export { MAX_COLLECTION_LENGTH };
