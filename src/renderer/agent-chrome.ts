/**
 * Pure helpers for the agent panel.
 *
 * The panel component holds only JSX. Everything with a decision in it lives
 * here, because the test runner covers `.ts` and not `.tsx` — logic left in a
 * component is logic nothing can check.
 */

import {
  isTerminalStatus,
  providerDescriptor,
  type AgentConfigStatus,
  type AgentRunState,
  type AgentRunStatus,
  type AgentSkillSummary,
  type AgentSnapshot,
  type AgentStepKind
} from "../shared/agents.js";
import type { BrowserSnapshot } from "../shared/browser.js";
import { focusedTab } from "./browser-chrome.js";

/** The run the panel should be showing: the active one, else the most recent. */
export function visibleRun(snapshot: AgentSnapshot): AgentRunState | null {
  if (snapshot.activeRunId !== null) {
    const active = snapshot.runs.find((run) => run.id === snapshot.activeRunId);
    if (active !== undefined) return active;
  }
  return snapshot.runs.at(-1) ?? null;
}

/**
 * Present-tense status text.
 *
 * `awaiting-approval` and `paused` read differently on purpose: one is a
 * question being asked now, the other is a question that outlived a restart.
 */
export function statusLabel(status: AgentRunStatus | null): string {
  switch (status) {
    case null:
    case "idle":
      return "Ready";
    case "planning":
      return "Planning";
    case "acting":
      return "Working";
    case "awaiting-approval":
      return "Needs your approval";
    case "paused":
      return "Paused";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

/** True while the run is advancing on its own and could be interrupted. */
export function isRunAdvancing(status: AgentRunStatus | null): boolean {
  return status === "planning" || status === "acting";
}

/** True when the run has stopped for good and a new task is the way forward. */
export function isRunFinished(status: AgentRunStatus | null): boolean {
  return status !== null && isTerminalStatus(status);
}

/**
 * A modifier suffix for the step's row, so tone lives in CSS rather than in
 * inline colour decisions scattered through the component.
 */
export function stepTone(kind: AgentStepKind): "neutral" | "quiet" | "bad" {
  switch (kind) {
    case "error":
      return "bad";
    case "thought":
    case "tool-call":
    case "tool-result":
      return "quiet";
    case "message":
      return "neutral";
  }
}

/** Wall-clock `HH:MM` for a step, zero-padded so the log stays column-aligned. */
export function formatStepTime(at: number): string {
  const when = new Date(at);
  const hours = String(when.getHours()).padStart(2, "0");
  const minutes = String(when.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * What a fresh composer should offer as context.
 *
 * The focused tab only. Sharing every open tab by default would make "the agent
 * sees what I chose" untrue on the very first run.
 */
export function defaultContextTabIds(
  snapshot: BrowserSnapshot
): readonly string[] {
  const tab = focusedTab(snapshot);
  return tab === null ? [] : [tab.id];
}

/** Toggles one tab in the selected context set, preserving snapshot order. */
export function toggleContextTab(
  selected: readonly string[],
  tabId: string,
  snapshot: BrowserSnapshot
): readonly string[] {
  const next = selected.includes(tabId)
    ? selected.filter((id) => id !== tabId)
    : [...selected, tabId];

  return snapshot.tabs.map((tab) => tab.id).filter((id) => next.includes(id));
}

/** Whether the composer's submit should be live. */
export function canSubmitTask(task: string, status: AgentRunStatus | null): boolean {
  return task.trim().length > 0 && !isRunAdvancing(status);
}

/* ------------------------------------------------------------------------- */
/* Provider configuration                                                     */
/* ------------------------------------------------------------------------- */

export type ConfigState = "unavailable" | "disconnected" | "connected";

/**
 * Which of three mutually exclusive things the config area should say.
 *
 * `unavailable` outranks the others: when the OS cannot encrypt, OpenStrawberry
 * refuses to store a key at all, so offering an input would invite the user to
 * type a secret into a field that is guaranteed to reject it.
 */
export function configState(config: AgentConfigStatus): ConfigState {
  if (config.encryption !== "available") return "unavailable";
  return config.configured ? "connected" : "disconnected";
}

/**
 * The one thing to say when no key can be stored, or null when one can.
 *
 * The two refusals read differently on purpose. `no-keyring` names a fixable
 * local condition and says what to fix, because the generic "no encryption here"
 * would send a Linux user hunting for the fault in OpenStrawberry when the answer
 * is that nothing is holding their secrets yet.
 */
export function encryptionNotice(config: AgentConfigStatus): string | null {
  switch (config.encryption) {
    case "available":
      return null;
    case "no-keyring":
      return (
        "No system keyring is available, so OpenStrawberry will not store a " +
        "provider key. Install or unlock one — GNOME Keyring or KWallet — then " +
        "connect again."
      );
    case "unavailable":
      return (
        "This system offers no OS-level encryption, so OpenStrawberry will not " +
        "store a provider key. Runs stop after reading context."
      );
  }
}

/**
 * A provider's display name.
 *
 * A shipped provider carries its own label, because casing is a name and not a
 * transformation — "OpenAI" does not survive being title-cased. Anything else
 * falls back to title case rather than to a blank.
 */
export function providerLabel(provider: string): string {
  const descriptor = providerDescriptor(provider);
  if (descriptor !== null) return descriptor.label;
  if (provider.length === 0) return "Unknown";
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

/** What a connected provider reads as: "Anthropic · claude-opus-5". */
export function configSummary(config: AgentConfigStatus): string {
  return `${providerLabel(config.provider)} · ${config.model}`;
}

/** Whether a typed key is worth submitting. Trimmed, because keys never have edges. */
export function canSaveCredential(key: string, config: AgentConfigStatus): boolean {
  return key.trim().length > 0 && config.encryption === "available";
}

/**
 * Ranks prompt suggestions for a companion's role.
 *
 * A skill tagged for the role sorts ahead of one that merely exists, so a
 * research companion is not offered a sales opener first.
 */
export function suggestionsForRole(
  skills: readonly AgentSkillSummary[],
  role: string,
  limit = 4
): readonly AgentSkillSummary[] {
  const scored = skills.map((skill) => ({
    skill,
    score: skill.tags.includes(role) ? 1 : 0
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.skill);
}
