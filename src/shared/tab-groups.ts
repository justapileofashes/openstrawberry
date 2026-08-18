/**
 * Persistent tab groups: a name, a colour, and a collapse state.
 *
 * Two decisions shape the contract.
 *
 * **A colour is a token, not a colour.** `GROUP_COLOURS` is a closed set of
 * names; the stylesheet owns what each one looks like. The renderer never
 * receives a CSS value from stored state and never interpolates one, so a
 * hand-edited file cannot put a string into a style attribute. A group is also
 * never identified by colour alone - it carries a name, and the rail marks
 * membership by shape as well as tone.
 *
 * **A group holds no addresses.** Membership lives on the tab, as a group id.
 * That keeps one fact in one place: a tab is in at most one group, and closing a
 * tab cannot leave a group holding a reference to something gone.
 *
 * Pure ASCII, so the closed sets stay reviewable.
 */

import {
  IpcValidationError,
  requireBoolean,
  requireIdentifier,
  requireOneOf,
  requirePlainObject,
  requireString
} from "./ipc-validation.js";

/** How many groups one window may hold. Well past what anyone organises by hand. */
export const MAX_TAB_GROUPS = 20;

export const MAX_GROUP_NAME_LENGTH = 40;

/**
 * The palette, as tokens.
 *
 * Names rather than values, so the stylesheet stays the single authority on what
 * the chrome looks like and stored state can never carry a CSS string.
 */
export const GROUP_COLOURS = [
  "slate",
  "amber",
  "rose",
  "violet",
  "teal",
  "lime"
] as const;

export type GroupColour = (typeof GROUP_COLOURS)[number];

export const DEFAULT_GROUP_COLOUR: GroupColour = "slate";

export interface TabGroup {
  readonly id: string;
  readonly name: string;
  readonly colour: GroupColour;
  /** Collapsed hides members in the rail. It never closes or unloads them. */
  readonly collapsed: boolean;
}

/** Control characters and bidi overrides, which have no place in a label. */
const UNSAFE_DISPLAY = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "gu"
);

export function groupName(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(UNSAFE_DISPLAY, "").replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > MAX_GROUP_NAME_LENGTH
    ? cleaned.slice(0, MAX_GROUP_NAME_LENGTH).trimEnd()
    : cleaned;
}

export function parseColour(value: unknown): GroupColour {
  if (typeof value !== "string") return DEFAULT_GROUP_COLOUR;
  return (GROUP_COLOURS as readonly string[]).includes(value)
    ? (value as GroupColour)
    : DEFAULT_GROUP_COLOUR;
}

/**
 * The next colour to hand a new group.
 *
 * Cycles through the palette by how many groups already exist, so two groups
 * made in a row look different without the user having to choose.
 */
export function nextColour(existingCount: number): GroupColour {
  return GROUP_COLOURS[existingCount % GROUP_COLOURS.length] ?? DEFAULT_GROUP_COLOUR;
}

/** Reads one stored group, or null when nothing usable is there. */
export function parseTabGroup(raw: unknown): TabGroup | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  let id: string;
  try {
    id = requireIdentifier(entry["id"], "Group id");
  } catch {
    return null;
  }

  const name = groupName(entry["name"]);
  // A group with no readable name is a coloured bar nothing can identify.
  if (name.length === 0) return null;

  return {
    id,
    name,
    colour: parseColour(entry["colour"]),
    collapsed: entry["collapsed"] === true
  };
}

/** Reads a stored group list, dropping anything unusable. */
export function parseTabGroups(raw: unknown): readonly TabGroup[] {
  if (!Array.isArray(raw)) return [];

  const groups: TabGroup[] = [];
  const seen = new Set<string>();

  for (const entry of raw.slice(0, MAX_TAB_GROUPS)) {
    const group = parseTabGroup(entry);
    if (group === null || seen.has(group.id)) continue;
    seen.add(group.id);
    groups.push(group);
  }

  return groups;
}

/**
 * Drops groups nothing belongs to.
 *
 * Called after a tab closes. A group that has emptied has no rail presence and
 * no way to be reached again, so keeping it would accumulate invisible state.
 */
export function pruneEmptyGroups(
  groups: readonly TabGroup[],
  memberships: readonly (string | null)[]
): readonly TabGroup[] {
  const used = new Set(memberships.filter((id): id is string => id !== null));
  return groups.filter((group) => used.has(group.id));
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface CreateGroupPayload {
  readonly tabId: string;
  readonly name: string;
}

export function parseCreateGroupPayload(raw: unknown): CreateGroupPayload {
  const root = requirePlainObject(raw, "Group request");
  const name = groupName(requireString(root["name"], "Group name", MAX_GROUP_NAME_LENGTH));

  if (name.length === 0) throw new IpcValidationError("Group name must not be empty.");

  return { tabId: requireIdentifier(root["tabId"], "Tab ID"), name };
}

export interface GroupIdPayload {
  readonly groupId: string;
}

export function parseGroupIdPayload(raw: unknown): GroupIdPayload {
  const root = requirePlainObject(raw, "Group request");
  return { groupId: requireIdentifier(root["groupId"], "Group ID") };
}

export interface UpdateGroupPayload {
  readonly groupId: string;
  readonly name: string;
  readonly colour: GroupColour;
  readonly collapsed: boolean;
}

export function parseUpdateGroupPayload(raw: unknown): UpdateGroupPayload {
  const root = requirePlainObject(raw, "Group request");
  const name = groupName(requireString(root["name"], "Group name", MAX_GROUP_NAME_LENGTH));

  if (name.length === 0) throw new IpcValidationError("Group name must not be empty.");

  return {
    groupId: requireIdentifier(root["groupId"], "Group ID"),
    name,
    // A colour outside the palette is refused rather than defaulted: the
    // renderer only ever offers shipped tokens, so anything else is a payload
    // that did not come from the chrome.
    colour: requireOneOf(root["colour"], GROUP_COLOURS, "Group colour"),
    collapsed: requireBoolean(root["collapsed"], "Group collapsed")
  };
}

export interface AssignTabPayload {
  readonly tabId: string;
  /** Null removes the tab from whatever group it was in. */
  readonly groupId: string | null;
}

export function parseAssignTabPayload(raw: unknown): AssignTabPayload {
  const root = requirePlainObject(raw, "Group request");
  const groupId = root["groupId"];

  return {
    tabId: requireIdentifier(root["tabId"], "Tab ID"),
    groupId: groupId === null || groupId === undefined
      ? null
      : requireIdentifier(groupId, "Group ID")
  };
}
