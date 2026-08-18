/**
 * The command palette's catalogue, matching, and key handling.
 *
 * All of it pure, because the component holds only JSX: the test runner covers
 * `.ts` and not `.tsx`, so logic left in a component is logic nothing can check.
 * This is the same split `agent-chrome.ts` and `command-center.ts` make.
 *
 * Two things this module deliberately does not do:
 *
 *   - **It defines no actions.** A command is metadata: an id, a label, where it
 *     belongs, and what to press. What an id *does* is wired in the component,
 *     against capabilities the bridge already exposes. The palette therefore
 *     adds no IPC surface at all - it is a new way to reach existing verbs, not
 *     a new set of them.
 *   - **It never sees page content.** Commands act on the chrome. Nothing here
 *     reads a page, a URL, or a title, so the palette cannot become a place
 *     where a hostile page's text is displayed.
 */

/** Bounds what a user can type before matching stops being useful. */
export const MAX_QUERY_LENGTH = 128;

/** Bounds how many results are rendered at once. */
export const MAX_RESULTS = 12;

export const COMMAND_GROUPS = ["Tabs", "Navigation", "Workspace", "Tools"] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/**
 * A key chord.
 *
 * `mod` is the platform's primary modifier - Command on macOS, Control
 * everywhere else. Storing intent rather than a specific key is what lets one
 * catalogue serve both platforms without a second table to keep in step.
 */
export interface Shortcut {
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly group: CommandGroup;
  /** Extra words a user might search by. Never shown. */
  readonly keywords?: readonly string[];
  readonly shortcut?: Shortcut;
}

/**
 * The catalogue.
 *
 * Shortcuts follow the conventions a browser user already has in their hands -
 * Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+J - because a browser that invents its own
 * bindings for universal actions is a browser people fight. Anything without a
 * conventional binding is palette-only rather than given an invented one.
 */
export const COMMANDS: readonly Command[] = [
  { id: "tab.new", title: "New tab", group: "Tabs", shortcut: { key: "t", mod: true } },
  { id: "tab.close", title: "Close tab", group: "Tabs", shortcut: { key: "w", mod: true } },
  { id: "tab.next", title: "Next tab", group: "Tabs", keywords: ["cycle"] },
  { id: "tab.previous", title: "Previous tab", group: "Tabs", keywords: ["cycle"] },

  { id: "nav.back", title: "Back", group: "Navigation", shortcut: { key: "ArrowLeft", alt: true } },
  { id: "nav.forward", title: "Forward", group: "Navigation", shortcut: { key: "ArrowRight", alt: true } },
  { id: "nav.reload", title: "Reload page", group: "Navigation", shortcut: { key: "r", mod: true } },
  { id: "nav.stop", title: "Stop loading", group: "Navigation", keywords: ["cancel"] },
  {
    id: "nav.address",
    title: "Focus address bar",
    group: "Navigation",
    keywords: ["url", "search", "location"],
    shortcut: { key: "l", mod: true }
  },

  {
    id: "workspace.split",
    title: "Toggle split view",
    group: "Workspace",
    keywords: ["pane", "side by side"],
    shortcut: { key: "\\", mod: true }
  },
  {
    id: "group.new",
    title: "Group this tab",
    group: "Workspace",
    keywords: ["tab group", "organise", "colour"],
    shortcut: { key: "g", mod: true, shift: true }
  },
  {
    id: "group.toggle",
    title: "Collapse or expand this group",
    group: "Workspace",
    keywords: ["tab group", "fold", "hide"]
  },
  {
    id: "group.ungroup",
    title: "Remove this tab from its group",
    group: "Workspace",
    keywords: ["tab group", "ungroup"]
  },
  {
    id: "workspace.snapshots",
    title: "Saved workspaces",
    group: "Workspace",
    keywords: ["snapshot", "session", "restore", "save tabs"],
    shortcut: { key: "s", mod: true, shift: true }
  },

  {
    id: "tools.downloads",
    title: "Downloads",
    group: "Tools",
    keywords: ["files", "saved"],
    shortcut: { key: "j", mod: true }
  },
  {
    id: "tools.reader",
    title: "Reader mode",
    group: "Tools",
    keywords: ["article", "read", "text"]
  },
  {
    id: "tools.agents",
    title: "Agents",
    group: "Tools",
    keywords: ["companion", "assistant"]
  },
  {
    id: "tools.settings",
    title: "Settings",
    group: "Tools",
    keywords: ["appearance", "preferences"],
    shortcut: { key: ",", mod: true }
  },
  {
    id: "tools.tracking",
    title: "Allow trackers on this site",
    group: "Tools",
    keywords: ["privacy", "shield", "blocking", "exception"]
  }
];

/* -------------------------------------------------------------------------- */
/* Shortcut display and matching                                               */
/* -------------------------------------------------------------------------- */

/** How a chord reads on this platform. */
export function shortcutLabel(shortcut: Shortcut, platform: string): string {
  const mac = platform === "darwin";
  const parts: string[] = [];

  if (shortcut.mod) parts.push(mac ? "Cmd" : "Ctrl");
  if (shortcut.alt) parts.push(mac ? "Option" : "Alt");
  if (shortcut.shift) parts.push("Shift");

  const key = shortcut.key;
  if (key === "ArrowLeft") parts.push("Left");
  else if (key === "ArrowRight") parts.push("Right");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key);

  return parts.join("+");
}

/** The minimal projection of a keyboard event these checks need. */
export interface KeyChord {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * Whether a keypress is a chord.
 *
 * Modifiers are matched exactly, in both directions: a command wanting Ctrl+T
 * must not fire on Ctrl+Shift+T, which is conventionally a different action
 * entirely. Being strict here is what keeps a binding from swallowing its
 * neighbour.
 */
export function matchesShortcut(
  event: KeyChord,
  shortcut: Shortcut,
  platform: string
): boolean {
  const mod = platform === "darwin" ? event.metaKey : event.ctrlKey;
  // The non-primary modifier must be absent, or Cmd+T on a Mac would also fire
  // for Ctrl+T and vice versa.
  const otherMod = platform === "darwin" ? event.ctrlKey : event.metaKey;

  if (otherMod) return false;
  if (mod !== (shortcut.mod ?? false)) return false;
  if (event.shiftKey !== (shortcut.shift ?? false)) return false;
  if (event.altKey !== (shortcut.alt ?? false)) return false;

  return event.key.toLowerCase() === shortcut.key.toLowerCase();
}

/** The command a keypress invokes, or null. */
export function commandForChord(event: KeyChord, platform: string): Command | null {
  return (
    COMMANDS.find(
      (command) =>
        command.shortcut !== undefined && matchesShortcut(event, command.shortcut, platform)
    ) ?? null
  );
}

/** Whether a keypress should open the palette itself. */
export function isPaletteChord(event: KeyChord, platform: string): boolean {
  return matchesShortcut(event, { key: "k", mod: true }, platform);
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Scores a command against a query, or null when it does not match.
 *
 * A subsequence match, so "ntb" finds "New tab", with the score favouring
 * matches that start words and run contiguously. The alternative - substring
 * only - fails the thing people actually do, which is type initials.
 *
 * Keywords match but score lower than the title, so a command whose visible
 * label matches always sorts above one that matched on a hidden synonym. A
 * result you cannot see the reason for is a result that looks like a bug.
 */
export function scoreCommand(command: Command, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 0;

  const titleScore = scoreText(command.title.toLowerCase(), needle);
  if (titleScore !== null) return titleScore;

  for (const keyword of command.keywords ?? []) {
    const keywordScore = scoreText(keyword.toLowerCase(), needle);
    // Halved, so a hidden synonym never outranks a visible label.
    if (keywordScore !== null) return keywordScore / 2;
  }

  return null;
}

function scoreText(haystack: string, needle: string): number | null {
  let score = 0;
  let position = 0;
  let previousMatch = -2;

  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found === -1) return null;

    // Contiguous characters are a stronger signal than scattered ones.
    if (found === previousMatch + 1) score += 3;
    // So is landing on the start of a word, which is what initials do.
    if (found === 0 || haystack[found - 1] === " ") score += 2;

    score += 1;
    previousMatch = found;
    position = found + 1;
  }

  // A short label matching is a better hit than a long one containing the same
  // letters somewhere.
  return score - haystack.length / 100;
}

/**
 * The commands to show for a query, best first.
 *
 * An empty query lists everything in catalogue order, which groups related
 * commands together and gives the palette a browsable resting state rather than
 * an empty one.
 */
export function filterCommands(
  query: string,
  available: readonly Command[] = COMMANDS
): readonly Command[] {
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);

  if (trimmed.length === 0) return available.slice(0, MAX_RESULTS);

  const scored: { command: Command; score: number }[] = [];
  for (const command of available) {
    const score = scoreCommand(command, trimmed);
    if (score !== null) scored.push({ command, score });
  }

  // Sorted by score, then by catalogue order, so equal matches stay stable
  // rather than reshuffling as the user types.
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return available.indexOf(left.command) - available.indexOf(right.command);
  });

  return scored.slice(0, MAX_RESULTS).map((entry) => entry.command);
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Moves the highlighted row, wrapping at both ends.
 *
 * Wrapping because the list is short and a user pressing Up from the top means
 * "the last one", not "nothing happens".
 */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count === 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** Keeps a selection valid as the result list changes underneath it. */
export function clampSelection(current: number, count: number): number {
  if (count === 0) return 0;
  return Math.min(Math.max(0, current), count - 1);
}
