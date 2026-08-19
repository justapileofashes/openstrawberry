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
  hasOwnCredential,
  MAX_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_BASE_URL_LENGTH,
  MAX_COMMAND_LENGTH,
  MAX_MODEL_LENGTH,
  providerDescriptor,
  resolvedProvider,
  type AgentCompanion,
  type AgentConfigStatus,
  type ProviderId,
  type ProviderStatus
} from "../shared/agents.js";
import type { CompanionDraft } from "../shared/bridge.js";
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
  return { name: "", role: "", provider: null, model: "", baseUrl: "", command: "" };
}

export function draftFrom(companion: AgentCompanion): AgentDraft {
  return {
    name: companion.name,
    role: companion.role,
    provider: companion.provider,
    model: companion.model ?? "",
    baseUrl: companion.baseUrl ?? "",
    command: companion.command ?? ""
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
  return true;
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
    command: draftIsCli(draft) && command.length > 0 ? command : null
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
}

/** The saved orchestrator, as the form holds it. */
export function orchestratorDraftFrom(config: AgentConfigStatus): OrchestratorDraft {
  const descriptor = providerDescriptor(config.provider);
  return {
    provider: descriptor?.id ?? "anthropic",
    model: config.model,
    baseUrl: config.baseUrl ?? "",
    command: config.command ?? ""
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

  const baseUrl = orchestratorNeedsBaseUrl(draft) ? draft.baseUrl.trim() : "";
  return (
    draft.provider !== config.provider ||
    model !== config.model ||
    baseUrl !== (config.baseUrl ?? "") ||
    command !== (config.command ?? "")
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

  // A CLI route names the program, because that is what would run — and the
  // model is the tool's business unless it was explicitly overridden.
  if (route.command !== null) {
    const model = route.model.length === 0 ? "" : ` · ${route.model}`;
    return `${providerName(route.provider)} · ${route.command}${model}${inherited}`;
  }

  const model = route.model.length === 0 ? "no model set" : route.model;
  const host = route.baseUrl === null ? "" : ` · ${hostOf(route.baseUrl)}`;

  return `${providerName(route.provider)} · ${model}${host}${inherited}`;
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
