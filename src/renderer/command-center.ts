/**
 * Pure helpers for the agent command center.
 *
 * The component holds only JSX. Everything with a decision in it lives here,
 * because the test runner covers `.ts` and not `.tsx` — logic left in a
 * component is logic nothing can check. This is the same split `agent-chrome.ts`
 * makes for the panel, and for the same reason.
 */

import {
  defaultCommandFor,
  defaultModelFor,
  emptyTuning,
  hasOwnCredential,
  resolveTuning,
  MAX_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_BASE_URL_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_CONTEXT_WINDOW,
  MAX_MODEL_LENGTH,
  MAX_PROVIDER_LABEL_LENGTH,
  MAX_TEMPERATURE,
  MIN_CONTEXT_WINDOW,
  providerDescriptor,
  resolvedProvider,
  type AgentCompanion,
  type AgentConfigStatus,
  type ModelTuning,
  type ProviderId,
  type ProviderStatus
} from "../shared/agents.js";
import type { CompanionDraft, ProviderTestRequest } from "../shared/bridge.js";
import type { ProviderErrorCode } from "../shared/provider-request.js";
import { providerLabel } from "./agent-chrome.js";

/**
 * An agent as the form holds it, which is not how the contract holds one.
 *
 * The two differences are deliberate. `model` is `""` rather than null while
 * editing, because a text input has no null to give; and `provider` keeps null
 * as a real choice, because "follows the orchestrator" is a selection the user
 * makes rather than the absence of one.
 */
export interface AgentDraft {
  readonly name: string;
  readonly role: string;
  readonly provider: ProviderId | null;
  readonly model: string;
  readonly baseUrl: string;
  readonly command: string;
  readonly tuning: TuningDraft;
}

/**
 * Model settings as the form holds them.
 *
 * Text rather than numbers, for the same reason `model` is a string here: a
 * number input hands back `""` while it is being cleared and `NaN` while it is
 * being typed into, and a draft that stores either has already lost the
 * difference between "empty" and "invalid". The conversion happens once, at
 * `toModelTuning`, where both are handled deliberately.
 *
 * `supportsImages` is the exception, because a checkbox genuinely has two
 * states — but it is nullable all the same, since a draft with no provider
 * chosen has not answered the question.
 */
export interface TuningDraft {
  readonly providerLabel: string;
  readonly supportsImages: boolean | null;
  readonly contextWindow: string;
  readonly temperature: string;
}

export function emptyTuningDraft(): TuningDraft {
  return {
    providerLabel: "",
    supportsImages: null,
    contextWindow: "",
    temperature: ""
  };
}

/** The saved settings, as the form holds them. Nulls become empty boxes. */
export function tuningDraftFrom(tuning: ModelTuning): TuningDraft {
  return {
    providerLabel: tuning.providerLabel ?? "",
    supportsImages: tuning.supportsImages,
    contextWindow: tuning.contextWindow === null ? "" : String(tuning.contextWindow),
    temperature: tuning.temperature === null ? "" : String(tuning.temperature)
  };
}

/**
 * What the settings become when a provider is chosen.
 *
 * The two the preset actually knows are prefilled, and the two it cannot know
 * are left empty. Called on every provider change, so a window belonging to one
 * provider never survives into another — the same rule the model, endpoint, and
 * command already follow.
 */
export function tuningDraftFor(provider: ProviderId | null): TuningDraft {
  const descriptor = provider === null ? null : providerDescriptor(provider);
  if (descriptor === null) return emptyTuningDraft();

  return {
    providerLabel: "",
    supportsImages: descriptor.supportsImages,
    contextWindow:
      descriptor.defaultContextWindow === null
        ? ""
        : String(descriptor.defaultContextWindow),
    temperature: ""
  };
}

/**
 * True when the box holds a context window the contract will accept.
 *
 * Empty is valid and means "the provider's own". Anything else has to be a
 * whole number of tokens in range, checked here so the Apply button is honest
 * rather than firing a write that is guaranteed to be rejected.
 */
export function isValidContextWindow(text: string): boolean {
  const value = text.trim();
  if (value.length === 0) return true;
  if (!/^\d+$/u.test(value)) return false;

  const parsed = Number(value);
  return (
    Number.isSafeInteger(parsed) &&
    parsed >= MIN_CONTEXT_WINDOW &&
    parsed <= MAX_CONTEXT_WINDOW
  );
}

/** True when the box holds a temperature the contract will accept. Empty is fine. */
export function isValidTemperature(text: string): boolean {
  const value = text.trim();
  if (value.length === 0) return true;
  if (!/^\d+(\.\d+)?$/u.test(value)) return false;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_TEMPERATURE;
}

/** True when the name box holds something short enough to store. Empty is fine. */
export function isValidProviderLabel(text: string): boolean {
  return text.trim().length <= MAX_PROVIDER_LABEL_LENGTH;
}

/** Whether every model setting in this draft would be accepted. */
export function canSaveTuning(draft: TuningDraft): boolean {
  return (
    isValidProviderLabel(draft.providerLabel) &&
    isValidContextWindow(draft.contextWindow) &&
    isValidTemperature(draft.temperature)
  );
}

/**
 * The contract shape, with the form's empty boxes normalised back to null.
 *
 * Null throughout for a draft with no provider: an agent that follows the
 * orchestrator follows its settings too, and sending half of its own would be
 * storing a temperature against a route it does not control.
 */
export function toModelTuning(
  provider: ProviderId | null,
  draft: TuningDraft
): ModelTuning {
  if (provider === null) return emptyTuning();

  const label = draft.providerLabel.trim();
  const contextWindow = draft.contextWindow.trim();
  const temperature = draft.temperature.trim();

  return {
    // A name identical to the provider's own is not a name the user gave; it is
    // the placeholder they left alone, and storing it would pin the label
    // against a preset that may be renamed later.
    providerLabel:
      label.length === 0 || label === providerName(provider) ? null : label,
    supportsImages: draft.supportsImages,
    contextWindow:
      contextWindow.length === 0 || !isValidContextWindow(contextWindow)
        ? null
        : Number(contextWindow),
    temperature:
      temperature.length === 0 || !isValidTemperature(temperature)
        ? null
        : Number(temperature)
  };
}

/** The model charset the contract enforces, checked here so the form can too. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

/** The command charset, likewise mirrored from the contract. */
const COMMAND_PATTERN = /^[A-Za-z0-9 ._:\\/-]+$/u;

/**
 * Turns what the user typed into a role slug.
 *
 * A role crosses IPC as an identifier, so the chrome derives one rather than
 * letting the user's spacing and punctuation reach a validator that would
 * reject the whole save with nothing to point at.
 */
export function slugifyRole(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
}

export function emptyDraft(): AgentDraft {
  return {
    name: "",
    role: "",
    provider: null,
    model: "",
    baseUrl: "",
    command: "",
    tuning: emptyTuningDraft()
  };
}

export function draftFrom(companion: AgentCompanion): AgentDraft {
  return {
    name: companion.name,
    role: companion.role,
    provider: companion.provider,
    model: companion.model ?? "",
    baseUrl: companion.baseUrl ?? "",
    command: companion.command ?? "",
    tuning: tuningDraftFrom(companion.tuning)
  };
}

/**
 * The role a draft would be saved under.
 *
 * Falls back to the name, then to a generic slug, rather than blocking the save:
 * a name written in a script that slugifies to nothing is a reason to pick a
 * default, not a reason to refuse to create the agent.
 */
export function draftRole(draft: AgentDraft): string {
  return slugifyRole(draft.role) || slugifyRole(draft.name) || "agent";
}

/** True when the model box holds something the contract will accept. */
export function isValidModel(model: string): boolean {
  const text = model.trim();
  if (text.length === 0 || text.length > MAX_MODEL_LENGTH) return false;
  if (text.includes("..") || text.includes("//")) return false;
  return MODEL_PATTERN.test(text);
}

/**
 * True when the endpoint box holds something the contract will accept.
 *
 * The same rules the trusted side enforces, mirrored so the Save button is honest
 * rather than firing a request that is guaranteed to be rejected. HTTPS is the
 * load-bearing one: this URL is where an API key gets sent.
 */
export function isValidBaseUrl(baseUrl: string): boolean {
  const text = baseUrl.trim();
  if (text.length === 0 || text.length > MAX_BASE_URL_LENGTH) return false;

  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

/**
 * True when the box holds something the contract will accept as a program.
 *
 * The point of mirroring this rule is not tidiness: a rejected command should be
 * rejected in front of the user, where they can see which character was the
 * problem, rather than by a validator whose message they never read.
 */
export function isValidCommand(command: string): boolean {
  const text = command.trim();
  if (text.length === 0 || text.length > MAX_COMMAND_LENGTH) return false;
  if (text.includes("..")) return false;
  if (!/[A-Za-z0-9]/u.test(text)) return false;
  return COMMAND_PATTERN.test(text);
}

/** Whether this draft's provider needs an endpoint the user has to name. */
export function draftNeedsBaseUrl(draft: AgentDraft): boolean {
  if (draft.provider === null) return false;
  return providerDescriptor(draft.provider)?.requiresBaseUrl === true;
}

/** Whether this draft's provider is a local CLI, and so runs a program. */
export function draftIsCli(draft: AgentDraft): boolean {
  if (draft.provider === null) return false;
  return providerDescriptor(draft.provider)?.transport === "cli";
}

/**
 * Whether this draft has to name a model.
 *
 * True only where nothing sensible happens otherwise. A CLI also ships no
 * default, but it chooses its own model, so requiring one there would be a
 * barrier the tool itself does not have.
 */
export function draftNeedsModel(draft: AgentDraft): boolean {
  if (draft.provider === null) return false;
  return providerDescriptor(draft.provider)?.requiresModel === true;
}

/** Whether the form is worth submitting. Blank model means "the default". */
export function canSaveAgent(draft: AgentDraft): boolean {
  const name = draft.name.trim();
  if (name.length === 0 || name.length > MAX_AGENT_NAME_LENGTH) return false;

  const model = draft.model.trim();
  if (model.length === 0 && draftNeedsModel(draft)) return false;
  if (model.length > 0 && !isValidModel(model)) return false;

  if (draftNeedsBaseUrl(draft) && !isValidBaseUrl(draft.baseUrl)) return false;

  // Blank is fine — it means the preset's command. Typed-and-wrong is not.
  const command = draft.command.trim();
  if (draftIsCli(draft) && command.length > 0 && !isValidCommand(command)) return false;

  return canSaveTuning(draft.tuning);
}

/** The contract shape, with the form's empty strings normalised back to null. */
export function toCompanionDraft(draft: AgentDraft): CompanionDraft {
  const model = draft.model.trim();
  const baseUrl = draft.baseUrl.trim();
  const command = draft.command.trim();

  return {
    name: draft.name.trim(),
    role: draftRole(draft),
    provider: draft.provider,
    model: model.length === 0 ? null : model,
    // Only where the provider asks for one. Sending an endpoint for a preset
    // would leave a field that looks like it redirects the key and does not.
    baseUrl: draftNeedsBaseUrl(draft) && baseUrl.length > 0 ? baseUrl : null,
    // Likewise a program: an executable path stored against an HTTP provider is
    // config nothing reads, waiting for a future adapter to find it.
    command: draftIsCli(draft) && command.length > 0 ? command : null,
    tuning: toModelTuning(draft.provider, draft.tuning)
  };
}

/* ------------------------------------------------------------------------- */
/* Providers                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Whether runs against this provider could actually proceed.
 *
 * Not the same as "has a key": a provider that runs on this machine
 * authenticates nothing, so treating a missing key as a fault would report a
 * problem with no fix.
 */
export function providerReady(status: ProviderStatus): boolean {
  return status.configured || !status.requiresCredential;
}

/**
 * One line about a provider's key, in the words its own kind deserves.
 *
 * A CLI is not merely keyless. It holds a session of its own, and saying so is
 * the difference between "nothing authenticates here" and "something does, and
 * it is not this app" — which is what the user actually needs to know.
 */
export function providerSummary(status: ProviderStatus): string {
  if (status.transport === "cli") {
    return `Signs in through its own CLI · runs ${status.defaultCommand ?? "locally"}`;
  }
  if (!status.requiresCredential) return "Runs locally · no key needed";
  return status.configured ? "Key stored" : "No key stored";
}

/** The provider's own name, so "OpenAI" is not title-cased into "Openai". */
export function providerName(provider: string): string {
  return providerDescriptor(provider)?.label ?? providerLabel(provider);
}

export function providerStatusFor(
  config: AgentConfigStatus,
  provider: string
): ProviderStatus | null {
  return config.providers.find((entry) => entry.id === provider) ?? null;
}

/* ------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* ------------------------------------------------------------------------- */

export interface OrchestratorDraft {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly command: string;
  readonly tuning: TuningDraft;
}

/** The saved orchestrator, as the form holds it. */
export function orchestratorDraftFrom(config: AgentConfigStatus): OrchestratorDraft {
  const descriptor = providerDescriptor(config.provider);
  return {
    provider: descriptor?.id ?? "anthropic",
    model: config.model,
    baseUrl: config.baseUrl ?? "",
    command: config.command ?? "",
    tuning: tuningDraftFrom(config.tuning)
  };
}

/** Whether the orchestrator's provider needs an endpoint the user names. */
export function orchestratorNeedsBaseUrl(draft: OrchestratorDraft): boolean {
  return providerDescriptor(draft.provider)?.requiresBaseUrl === true;
}

/** Whether the orchestrator's provider is a local CLI, and so runs a program. */
export function orchestratorIsCli(draft: OrchestratorDraft): boolean {
  return providerDescriptor(draft.provider)?.transport === "cli";
}

/**
 * Whether the orchestrator form has something to apply.
 *
 * Unchanged is not saveable. Repointing the orchestrator moves every agent that
 * follows it, so a button that stays live after the change has landed invites
 * the user to wonder whether it did.
 */
export function canSaveOrchestrator(
  draft: OrchestratorDraft,
  config: AgentConfigStatus
): boolean {
  const isCli = orchestratorIsCli(draft);

  // A CLI picks its own model, so an empty box there is the ordinary case.
  const model = draft.model.trim();
  if (!isCli && !isValidModel(model)) return false;
  if (isCli && model.length > 0 && !isValidModel(model)) return false;

  if (orchestratorNeedsBaseUrl(draft) && !isValidBaseUrl(draft.baseUrl)) return false;

  const command = isCli ? draft.command.trim() : "";
  if (command.length > 0 && !isValidCommand(command)) return false;

  if (!canSaveTuning(draft.tuning)) return false;

  const baseUrl = orchestratorNeedsBaseUrl(draft) ? draft.baseUrl.trim() : "";
  return (
    draft.provider !== config.provider ||
    model !== config.model ||
    baseUrl !== (config.baseUrl ?? "") ||
    command !== (config.command ?? "") ||
    tuningChanged(draft.provider, draft.tuning, config.tuning)
  );
}

/**
 * Whether the model settings differ from what is stored.
 *
 * Compared after normalisation rather than field by field, so a box holding
 * "0.20" and a stored 0.2 are the same setting — otherwise Apply would stay lit
 * after a save and invite the user to wonder whether it landed.
 */
export function tuningChanged(
  provider: ProviderId | null,
  draft: TuningDraft,
  saved: ModelTuning
): boolean {
  const next = toModelTuning(provider, draft);
  return (
    next.providerLabel !== saved.providerLabel ||
    next.supportsImages !== saved.supportsImages ||
    next.contextWindow !== saved.contextWindow ||
    next.temperature !== saved.temperature
  );
}

/* ------------------------------------------------------------------------- */
/* Roster                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * What the roster row says about an agent, in one word the chrome can style.
 *
 * `no-encryption` outranks `needs-key`, because when nothing can be stored the
 * missing key is not the user's next action — there is no action that would fix
 * it here.
 */
export type AgentReadiness = "ready" | "needs-key" | "no-encryption";

/**
 * An agent's own key counts, and counts first.
 *
 * Without this an agent given its own OpenRouter key would still be reported as
 * needing one whenever the shared key was absent — the panel telling the user to
 * fix something they had already fixed.
 */
export function agentHasUsableKey(
  companion: AgentCompanion | null,
  config: AgentConfigStatus
): boolean {
  const route = resolvedProvider(companion, config);
  const status = providerStatusFor(config, route.provider);
  if (status === null) return false;

  if (companion !== null && hasOwnCredential(config, companion.id, route.provider)) {
    return true;
  }
  return status.configured;
}

export function agentReadiness(
  companion: AgentCompanion | null,
  config: AgentConfigStatus
): AgentReadiness {
  const route = resolvedProvider(companion, config);
  const status = providerStatusFor(config, route.provider);

  if (status !== null && !status.requiresCredential) return "ready";
  if (agentHasUsableKey(companion, config)) return "ready";
  if (config.encryption !== "available") return "no-encryption";
  return "needs-key";
}

/**
 * "Anthropic · claude-opus-5", plus whatever else the route actually depends on.
 *
 * The endpoint is included when there is one, because with a compatible service
 * the host *is* the provider — two agents both reading "OpenAI-compatible ·
 * llama-3.3" can be pointed at entirely different machines.
 */
export function routeSummary(
  companion: AgentCompanion | null,
  config: AgentConfigStatus
): string {
  const route = resolvedProvider(companion, config);
  const inherited = route.inherited ? " · follows orchestrator" : "";
  /*
   * The name the user gave this configuration, falling back to the provider's
   * own. This is the line where it earns its keep: two agents on two different
   * machines both reading "OpenAI-compatible" is the exact confusion the field
   * exists to prevent, and the roster is where they are read side by side.
   */
  const name = route.tuning.providerLabel;

  // A CLI route names the program, because that is what would run — and the
  // model is the tool's business unless it was explicitly overridden.
  if (route.command !== null) {
    const model = route.model.length === 0 ? "" : ` · ${route.model}`;
    return `${name} · ${route.command}${model}${inherited}`;
  }

  const model = route.model.length === 0 ? "no model set" : route.model;
  const host = route.baseUrl === null ? "" : ` · ${hostOf(route.baseUrl)}`;

  return `${name} · ${model}${host}${inherited}`;
}

/**
 * The orchestrator's own line, with nothing said about following.
 *
 * `routeSummary(null, config)` resolves through the inherit path and so ends in
 * "follows orchestrator" — true of an agent reading that line, and nonsense on
 * the orchestrator's own row, which is the thing being followed. Two callers
 * need the plain line: that row, and the "Follows the orchestrator · …" summary
 * an unpinned agent shows, where the suffix would say it twice.
 */
export function orchestratorRouteSummary(config: AgentConfigStatus): string {
  const command = config.command ?? defaultCommandFor(config.provider);
  const name = resolveTuning(config.provider, config.tuning).providerLabel;

  if (command !== null) {
    const model = config.model.length === 0 ? "" : ` · ${config.model}`;
    return `${name} · ${command}${model}`;
  }

  const model = config.model.length === 0 ? "no model set" : config.model;
  const host = config.baseUrl === null ? "" : ` · ${hostOf(config.baseUrl)}`;

  return `${name} · ${model}${host}`;
}

/**
 * The same line, for a route that is still being edited.
 *
 * `routeSummary` reads a saved agent, and an unsaved draft has no saved agent to
 * read — so the panel behind the dialog would otherwise describe the route the
 * user just changed away from.
 */
export function draftRouteSummary(
  draft: AgentDraft,
  config: AgentConfigStatus
): string {
  // Said once, at the front, where it answers the row's own question. The
  // orchestrator's line is taken plain so the sentence does not end by
  // repeating what it opened with.
  if (draft.provider === null) {
    return `Follows the orchestrator · ${orchestratorRouteSummary(config)}`;
  }

  const tuning = toModelTuning(draft.provider, draft.tuning);
  const name = tuning.providerLabel ?? providerName(draft.provider);
  const model = draft.model.trim();
  const baseUrl = draft.baseUrl.trim();
  const command = draft.command.trim();

  if (draftIsCli(draft)) {
    const program = command.length > 0 ? command : defaultCommandFor(draft.provider) ?? "";
    const named = model.length === 0 ? "" : ` · ${model}`;
    return `${name} · ${program}${named}`;
  }

  const named =
    model.length > 0
      ? model
      : defaultModelFor(draft.provider) || "no model set";
  const host = baseUrl.length === 0 ? "" : ` · ${hostOf(baseUrl)}`;

  return `${name} · ${named}${host}`;
}

/** The host of an endpoint, for a summary line that has no room for the rest. */
export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * What the empty model box should say.
 *
 * A default when there is one, and an instruction when there is not — an empty
 * box beside a provider with no default gives the user nothing to act on.
 */
export function draftModelPlaceholder(
  draft: AgentDraft,
  config: AgentConfigStatus
): string {
  if (draft.provider === null) return config.model;

  const fallback = defaultModelFor(draft.provider);
  if (fallback.length > 0) return fallback;
  if (draftNeedsModel(draft)) return "Required — the service's model ID";
  return "Optional — the CLI picks its own";
}

/** What the empty command box should say: the program the preset looks for. */
export function draftCommandPlaceholder(draft: AgentDraft): string {
  if (draft.provider === null) return "";
  return defaultCommandFor(draft.provider) ?? "";
}

/**
 * What the empty context-window box should say.
 *
 * The preset's number where there is one, and an honest admission where there
 * is not. A compatible endpoint serves whatever its operator loaded, so an
 * invented figure there would be a guess wearing the authority of a default.
 */
export function contextWindowPlaceholder(provider: ProviderId | null): string {
  if (provider === null) return "Follows the orchestrator";

  const descriptor = providerDescriptor(provider);
  if (descriptor === null) return "";
  if (descriptor.transport === "cli") return "Managed by the CLI";
  return descriptor.defaultContextWindow === null
    ? "Optional — the model's window in tokens"
    : String(descriptor.defaultContextWindow);
}

/* ------------------------------------------------------------------------- */
/* Trying a configuration                                                     */
/* ------------------------------------------------------------------------- */

/**
 * What a test is doing, or what it found.
 *
 * `idle` is a distinct state rather than a null result, because "not tried" and
 * "tried and came back clean" must not look alike on a button the user is about
 * to trust.
 */
export type TestState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "passed"; readonly elapsedMs: number }
  | { readonly kind: "failed"; readonly code: ProviderErrorCode };

/**
 * Wording for every way a test can fail.
 *
 * Held here rather than taken from the provider, for the same reason the run log
 * holds its own: an error body is remote content, and a settings dialog is the
 * last place it should be rendered. Each line says what the user can do next
 * where there is something to do.
 */
const TEST_FAILURE_TEXT: Readonly<Record<ProviderErrorCode, string>> = {
  "no-credential": "No key is stored for this provider yet.",
  "unsupported-provider": "This build has no transport for that provider.",
  "bad-endpoint": "That base URL is not a usable https address.",
  network: "The request did not complete. Check the endpoint and your connection.",
  timeout: "The provider did not answer in time.",
  redirected: "The endpoint redirected the request, which is refused.",
  unauthorised: "The stored key was rejected.",
  "rate-limited": "The provider is rate limiting requests. Try again shortly.",
  "provider-error": "The provider returned an error. Check the model name.",
  "malformed-reply": "The reply could not be read as a completion.",
  "too-large": "The reply was larger than this app will read.",
  cancelled: "The test was cancelled.",
  "command-not-allowed": "That program is not one this app will run.",
  "command-failed": "The command did not run successfully.",
  "no-output": "The command printed nothing."
};

/**
 * One line describing where a test got to. Null while nothing has been tried.
 *
 * `route` is what the pass line turns on, and it has to: a CLI route is checked
 * rather than called, so reporting that a provider answered — and how fast —
 * would describe a request that was never made. The two outcomes are not the
 * same claim, and the wording is where that has to show.
 */
export function testSummary(
  state: TestState,
  route: { readonly isCli: boolean; readonly command: string } = {
    isCli: false,
    command: ""
  }
): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "running":
      return route.isCli ? "Checking this program…" : "Trying this configuration…";
    case "passed":
      return route.isCli
        ? `${route.command || "That program"} is a program this build will run.`
        : `The provider answered in ${Math.max(1, Math.round(state.elapsedMs))} ms.`;
    case "failed":
      return TEST_FAILURE_TEXT[state.code];
  }
}

/**
 * Whether this configuration is complete enough to be worth trying.
 *
 * The same rules that gate Apply, because a test of a configuration that could
 * not be saved answers a question about a route that will never exist.
 */
export function canTestAgent(draft: AgentDraft): boolean {
  return draft.provider !== null && canSaveAgent(draft);
}

/** The test request for an agent's form, including whose key to authenticate with. */
export function agentTestRequest(
  draft: AgentDraft,
  companionId: string | null
): ProviderTestRequest | null {
  if (draft.provider === null) return null;

  const model = draft.model.trim();
  const baseUrl = draft.baseUrl.trim();
  const command = draft.command.trim();

  return {
    provider: draft.provider,
    model: model.length === 0 ? null : model,
    baseUrl: draftNeedsBaseUrl(draft) && baseUrl.length > 0 ? baseUrl : null,
    command: draftIsCli(draft) && command.length > 0 ? command : null,
    tuning: toModelTuning(draft.provider, draft.tuning),
    companionId
  };
}


/* ------------------------------------------------------------------------- */
/* Per-agent credentials                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Where this agent's key comes from.
 *
 * `none` is not an error state on its own — it is what an agent looks like
 * before either key exists — so the wording that goes with it belongs to
 * `agentReadiness`, which knows whether the provider wanted one.
 */
export type AgentKeySource = "own" | "shared" | "not-needed" | "none";

export function agentKeySource(
  companion: AgentCompanion,
  config: AgentConfigStatus
): AgentKeySource {
  const route = resolvedProvider(companion, config);
  const status = providerStatusFor(config, route.provider);

  if (status !== null && !status.requiresCredential) return "not-needed";
  if (hasOwnCredential(config, companion.id, route.provider)) return "own";
  return status?.configured === true ? "shared" : "none";
}

/** One line naming which key an agent authenticates with, and whose it is. */
export function agentKeySummary(
  companion: AgentCompanion,
  config: AgentConfigStatus
): string {
  const route = resolvedProvider(companion, config);
  const provider = providerName(route.provider);

  switch (agentKeySource(companion, config)) {
    case "not-needed":
      // A CLI is not merely keyless — it is already signed in as someone, and
      // that is worth saying, because it is not this app's session.
      return route.command !== null
        ? `${provider} signs in through its own CLI. OpenStrawberry stores no key for it.`
        : `${provider} runs locally, so this agent needs no key.`;
    case "own":
      return `This agent uses its own ${provider} key.`;
    case "shared":
      return `Using the shared ${provider} key.`;
    case "none":
      return `No ${provider} key yet — give this agent one, or connect the shared key below.`;
  }
}

export function canCreateAgent(companions: readonly AgentCompanion[]): boolean {
  return companions.length < MAX_AGENTS;
}

/**
 * The last agent stays. An empty roster has no composer to type into, and the
 * seeded agent would silently reappear on the next launch.
 */
export function canDeleteAgent(companions: readonly AgentCompanion[]): boolean {
  return companions.length > 1;
}
