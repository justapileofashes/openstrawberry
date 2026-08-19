/**
 * Named workspace snapshots: a set of open addresses, saved under a name.
 *
 * The rule that shapes this is the same one the session file follows, and it is
 * worth restating because a "workspace" sounds like it should carry more:
 *
 *   **A snapshot is addresses and labels. Nothing else.**
 *
 * No cookie, no session, no storage, no scroll position, no form state, no
 * credential. Opening a saved workspace navigates to the addresses; it does not
 * restore who you were logged in as, because none of that was ever captured.
 * There is no field on any type here that such a thing would fit in.
 *
 * Addresses pass the same http(s) gate as bookmarks, applied on write *and* on
 * read: a file that was hand-edited, or one written before the gate tightened,
 * cannot introduce a scheme the browser would refuse to navigate to anyway.
 *
 * Pure ASCII, so the bounds and the gate stay reviewable.
 */

import {
  IpcValidationError,
  requireIdentifier,
  requirePlainObject,
  requireString
} from "./ipc-validation.js";

/** How many workspaces a user can keep. Well past what anyone curates. */
export const MAX_WORKSPACES = 50;

/** How many addresses one workspace holds, matching the tab cap. */
export const MAX_WORKSPACE_TABS = 64;

export const MAX_WORKSPACE_NAME_LENGTH = 60;
export const MAX_WORKSPACE_TITLE_LENGTH = 200;
export const MAX_WORKSPACE_URL_LENGTH = 4096;

/** Later than any real save, and early enough to bound the field. */
export const MAX_TIMESTAMP = 4_102_444_800_000;

/**
 * One saved address.
 *
 * The title is a label for the list. It is not authoritative and is not used to
 * navigate; the url is.
 */
export interface WorkspaceTab {
  readonly url: string;
  readonly title: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly tabs: readonly WorkspaceTab[];
  readonly savedAt: number;
}

export interface WorkspaceSnapshot {
  readonly workspaces: readonly Workspace[];
}

export function emptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return { workspaces: [] };
}

/* -------------------------------------------------------------------------- */
/* Text and addresses                                                          */
/* -------------------------------------------------------------------------- */

/** C0 controls, DEL, C1 controls, and the bidi overrides. */
const UNSAFE_DISPLAY = new RegExp(
  "[\\u0000-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]",
  "gu"
);

/**
 * Reduces a name or title to something safe to store and show.
 *
 * A workspace name is user-typed and a title comes from a page, so both are
 * treated the same way: strip what would render as something other than what is
 * stored, collapse whitespace, and bound the length.
 */
export function workspaceText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(UNSAFE_DISPLAY, "").replace(/\s+/gu, " ").trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

/**
 * The scheme gate.
 *
 * http(s) only, the same set the navigation policy allows and bookmarks import.
 * `about:blank` is deliberately excluded: saving a blank tab preserves nothing,
 * and restoring one would add an empty tab the user did not ask for.
 */
export function isSavableUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_WORKSPACE_URL_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.hostname.length === 0) return false;
  // Credentials in a URL are a phishing staple and must not be persisted.
  return url.username === "" && url.password === "";
}

/**
 * Turns live tabs into savable ones.
 *
 * Blank and non-http(s) tabs are dropped rather than rejected: a window with one
 * blank tab among six real ones should still save the six.
 */
export function toWorkspaceTabs(
  tabs: readonly { readonly url: string; readonly title: string }[]
): readonly WorkspaceTab[] {
  const saved: WorkspaceTab[] = [];

  for (const tab of tabs) {
    if (saved.length >= MAX_WORKSPACE_TABS) break;
    if (!isSavableUrl(tab.url)) continue;

    saved.push({
      url: tab.url,
      title: workspaceText(tab.title, MAX_WORKSPACE_TITLE_LENGTH)
    });
  }

  return saved;
}

/* -------------------------------------------------------------------------- */
/* Payload validators                                                          */
/* -------------------------------------------------------------------------- */

export interface SaveWorkspacePayload {
  readonly name: string;
}

export function parseSaveWorkspacePayload(raw: unknown): SaveWorkspacePayload {
  const root = requirePlainObject(raw, "Workspace request");
  const name = workspaceText(
    requireString(root["name"], "Workspace name", MAX_WORKSPACE_NAME_LENGTH),
    MAX_WORKSPACE_NAME_LENGTH
  );

  // Reduced to nothing means it was only characters that do not display.
  if (name.length === 0) {
    throw new IpcValidationError("Workspace name must not be empty.");
  }

  return { name };
}

export interface WorkspaceIdPayload {
  readonly workspaceId: string;
}

export function parseWorkspaceIdPayload(raw: unknown): WorkspaceIdPayload {
  const root = requirePlainObject(raw, "Workspace request");
  return { workspaceId: requireIdentifier(root["workspaceId"], "Workspace ID") };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export const WORKSPACE_STATE_VERSION = 1;

export interface PersistedWorkspaces {
  readonly version: number;
  readonly workspaces: readonly Workspace[];
}

export function emptyWorkspaceState(): PersistedWorkspaces {
  return { version: WORKSPACE_STATE_VERSION, workspaces: [] };
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_TIMESTAMP);
}

/** Reads one stored workspace, or null when nothing usable is there. */
function parseWorkspace(raw: unknown): Workspace | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  let id: string;
  try {
    id = requireIdentifier(entry["id"], "Workspace id");
  } catch {
    return null;
  }

  const name = workspaceText(entry["name"], MAX_WORKSPACE_NAME_LENGTH);
  if (name.length === 0) return null;

  const rawTabs = Array.isArray(entry["tabs"]) ? entry["tabs"] : [];
  const tabs: WorkspaceTab[] = [];

  for (const rawTab of rawTabs.slice(0, MAX_WORKSPACE_TABS)) {
    if (typeof rawTab !== "object" || rawTab === null || Array.isArray(rawTab)) continue;
    const tab = rawTab as Record<string, unknown>;

    // The gate again, on read. A file edited by hand, or written before the
    // gate tightened, cannot introduce a scheme through the back door.
    if (!isSavableUrl(tab["url"])) continue;

    tabs.push({
      url: tab["url"],
      title: workspaceText(tab["title"], MAX_WORKSPACE_TITLE_LENGTH)
    });
  }

  // A workspace with no navigable address restores to nothing.
  if (tabs.length === 0) return null;

  return { id, name, tabs, savedAt: parseTimestamp(entry["savedAt"]) };
}

export function parseWorkspaces(raw: unknown): PersistedWorkspaces {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return emptyWorkspaceState();
  }

  const root = raw as Record<string, unknown>;
  if (root["version"] !== WORKSPACE_STATE_VERSION) return emptyWorkspaceState();

  const rawWorkspaces = Array.isArray(root["workspaces"]) ? root["workspaces"] : [];

  const workspaces: Workspace[] = [];
  const seen = new Set<string>();

  for (const entry of rawWorkspaces.slice(0, MAX_WORKSPACES)) {
    const workspace = parseWorkspace(entry);
    if (workspace === null || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    workspaces.push(workspace);
  }

  return { version: WORKSPACE_STATE_VERSION, workspaces };
}
