/**
 * What a page looks like to an agent, and how one element in it is named.
 *
 * `read_page` answers "what does this say". This module answers the question a
 * model has to be able to ask before it can do anything: "what is on this page
 * that I could act on, and how do I refer to one of those things".
 *
 * The answer is a flat list of nodes, each carrying a reference like `e12`. That
 * reference is the whole locator strategy. There is no CSS selector, no XPath,
 * and no coordinate in the contract, because all three are strings a model
 * invents and this process would then have to trust. A reference is an index
 * into a list this process built, so the worst a wrong one can do is miss.
 *
 * Four rules shape it, and the first two are the same ones reader mode and the
 * media controls already follow:
 *
 *   1. **The page's answer is untrusted JSON.** `buildPageSnapshot` re-derives
 *      every field. A page can return whatever it likes; it cannot return a
 *      field this file does not read, a role outside the closed set, a rect that
 *      is not a bounded integer, or a name longer than the cap.
 *
 *   2. **The page does not choose references.** `ref` is assigned here, by
 *      position, after validation. A page that returns a `ref` of its own has it
 *      ignored, so it cannot make one snapshot's `e5` mean something it chose in
 *      the next.
 *
 *   3. **A reference has no meaning without the snapshot that minted it.** They
 *      are renumbered on every capture and die with the page - see
 *      `snapshot-registry.ts`, which is what enforces that. This module only
 *      guarantees they are dense and stable *within* one list.
 *
 *   4. **A password is not a value.** `input[type=password]` reports its
 *      existence and never its contents, at this boundary as well as in the
 *      script, so a snapshot crossing into a transcript cannot carry one.
 */

/**
 * The kinds of thing a snapshot reports.
 *
 * Deliberately shorter than the ARIA role list. Every entry here is either
 * something an agent can act on, or something it needs in order to know where it
 * is and whether the last thing it did worked. A role a model cannot use is
 * tokens it pays for on every turn.
 */
export const SNAPSHOT_ROLES = [
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "option",
  "slider",
  "tab",
  "menuitem",
  "heading",
  /* Live regions, so a "Saved" that appears after a click shows up in the diff. */
  "alert",
  "image",
  "region"
] as const;

export type SnapshotRole = (typeof SNAPSHOT_ROLES)[number];

/**
 * What consent an element demands, decided from the element rather than the act.
 *
 * The act tells you a click was requested; only the element tells you whether
 * that click submits a form, opens a file picker, or fills in a password. Each
 * of those is answered differently, and answering them from the element is what
 * makes the answer the same however the click was phrased.
 */
export const SNAPSHOT_NODE_KINDS = ["ordinary", "submit", "file", "password"] as const;

export type SnapshotNodeKind = (typeof SNAPSHOT_NODE_KINDS)[number];

/** How many nodes one capture reports. A long page is truncated, not refused. */
export const MAX_SNAPSHOT_NODES = 300;

/** How long an accessible name may be before it is cut. */
export const MAX_NODE_NAME_LENGTH = 200;

/** How much of a field's current value is reported back. */
export const MAX_NODE_VALUE_LENGTH = 200;

/**
 * The largest coordinate or size a rect may claim.
 *
 * Matches the viewport bound the browser contract already uses. A page
 * reporting a rect outside it is describing something that is not on screen,
 * and a coordinate that large must never reach an input event.
 */
export const MAX_COORDINATE = 20_000;

/** How many lines of change one diff reports. */
export const MAX_DIFF_LINES = 40;

/** How many options of one `<select>` are listed. */
export const MAX_SELECT_OPTIONS = 60;

/** A rect in viewport CSS pixels. Always integers, always within bounds. */
export interface SnapshotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SnapshotNode {
  /** Minted here by position. Never read from the page. */
  readonly ref: string;
  readonly role: SnapshotRole;
  /** The accessible name, whitespace-collapsed and bounded. May be empty. */
  readonly name: string;
  /** A form control's current contents. Always null for a password field. */
  readonly value: string | null;
  readonly kind: SnapshotNodeKind;
  /** Checked state for a checkbox or radio; null for everything else. */
  readonly checked: boolean | null;
  readonly disabled: boolean;
  /**
   * A position within a `<select>`: the option's own for an option, and the
   * currently selected one for the combobox itself.
   *
   * Carried so a selection can be made with arrow keys, counted by this process
   * from the distance between the two, rather than by evaluating a string naming
   * the option inside the page.
   */
  readonly optionIndex: number | null;
  /**
   * For an option, the reference of the `<select>` it belongs to.
   *
   * Assigned here from document order rather than reported by the page: options
   * follow their control in the walk, so the last combobox seen is the owner.
   * Without it a selection would have to name two references and a model would
   * have to work out which pairs with which.
   */
  readonly ownerRef: string | null;
  /**
   * Whether the element sits inside a `<form>`.
   *
   * Carried for one decision: Enter pressed in a form field submits it, and
   * submitting is the act this browser stops for. Without this the gate would
   * have to fire on every Enter, including the ones that only close a menu.
   */
  readonly inForm: boolean;
  /** Whether the element is within the visible area. Off-screen cannot be clicked. */
  readonly inViewport: boolean;
  readonly rect: SnapshotRect;
}

/** One capture, as the registry holds it. */
export interface PageSnapshot {
  readonly nodes: readonly SnapshotNode[];
  /** The tab's navigation counter at capture. A change invalidates every ref. */
  readonly generation: number;
  readonly url: string;
  readonly title: string;
  readonly capturedAt: number;
  /** How many nodes the page offered beyond the cap. */
  readonly dropped: number;
}

/* ------------------------------------------------------------------------- */
/* Re-derivation                                                              */
/* ------------------------------------------------------------------------- */

function collapse(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

/**
 * A coordinate the process is willing to act on.
 *
 * Rounded to an integer and clamped into the viewport bound, because this number
 * is on its way to an input event: a fractional or absurd coordinate is not a
 * rendering curiosity there, it is a click somewhere nobody can see.
 */
function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded < 0) return 0;
  return rounded > MAX_COORDINATE ? MAX_COORDINATE : rounded;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * A position in a `<select>`.
 *
 * `-1` is kept rather than rejected: it is what a control with nothing selected
 * reports, and turning that into "no index" would lose the difference between a
 * select that has not been touched and one this process could not read.
 */
function optionalIndex(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < -1 || value >= MAX_SELECT_OPTIONS) return null;
  return value;
}

function roleOf(value: unknown): SnapshotRole | null {
  if (typeof value !== "string") return null;
  return (SNAPSHOT_ROLES as readonly string[]).includes(value) ? (value as SnapshotRole) : null;
}

function kindOf(value: unknown): SnapshotNodeKind {
  if (typeof value !== "string") return "ordinary";
  return (SNAPSHOT_NODE_KINDS as readonly string[]).includes(value)
    ? (value as SnapshotNodeKind)
    : "ordinary";
}

/**
 * Rebuilds a snapshot from whatever the in-page script handed back.
 *
 * Nothing the page returned is believed. An entry with an unrecognised role is
 * dropped rather than coerced, because a role is what decides how an element may
 * be acted on and guessing one wrong is how a click lands on the wrong thing.
 */
export function buildPageSnapshot(
  raw: unknown,
  context: {
    readonly generation: number;
    readonly url: string;
    readonly title: string;
    readonly capturedAt: number;
  }
): PageSnapshot {
  const source = Array.isArray(raw) ? raw : [];

  const nodes: SnapshotNode[] = [];
  let dropped = 0;
  /* The control an option belongs to: the last combobox seen in document order. */
  let lastComboboxRef: string | null = null;

  for (const entry of source) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;

    const candidate = entry as Record<string, unknown>;
    const role = roleOf(candidate["role"]);
    if (role === null) continue;

    if (nodes.length >= MAX_SNAPSHOT_NODES) {
      dropped += 1;
      continue;
    }

    const kind = kindOf(candidate["kind"]);
    const ref = `e${nodes.length + 1}`;
    if (role === "combobox") lastComboboxRef = ref;

    nodes.push({
      // Rule 2: position decides the reference, not the page.
      ref,
      role,
      name: collapse(candidate["name"], MAX_NODE_NAME_LENGTH),
      // Rule 4, applied again on this side. The script already refuses to read
      // one; this is what makes that a property of the boundary rather than of
      // the script's good behaviour.
      value: kind === "password" ? null : nullableValue(candidate["value"]),
      kind,
      checked: optionalBoolean(candidate["checked"]),
      disabled: candidate["disabled"] === true,
      optionIndex: optionalIndex(candidate["optionIndex"]),
      ownerRef: role === "option" ? lastComboboxRef : null,
      inForm: candidate["inForm"] === true,
      inViewport: candidate["inViewport"] === true,
      rect: {
        x: coordinate(candidate["x"]),
        y: coordinate(candidate["y"]),
        width: coordinate(candidate["width"]),
        height: coordinate(candidate["height"])
      }
    });
  }

  return {
    nodes,
    generation: context.generation,
    url: context.url,
    title: collapse(context.title, MAX_NODE_NAME_LENGTH),
    capturedAt: context.capturedAt,
    dropped
  };
}

function nullableValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/gu, " ").slice(0, MAX_NODE_VALUE_LENGTH);
}

/** Finds a node by the reference a model named. Null when there is no such one. */
export function nodeByRef(
  snapshot: PageSnapshot,
  ref: string
): SnapshotNode | null {
  return snapshot.nodes.find((node) => node.ref === ref) ?? null;
}

/* ------------------------------------------------------------------------- */
/* Wording                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * One node on one line.
 *
 * Plain text for the same reason the tab list is: this is read by a model, and
 * three short fields cost fewer tokens as a line than as an object. The
 * reference comes first because it is the only part any action takes.
 */
export function formatNode(node: SnapshotNode): string {
  const parts = [`[${node.ref}]`, node.role];

  if (node.name.length > 0) parts.push(JSON.stringify(node.name));

  if (node.checked !== null) parts.push(node.checked ? "checked" : "unchecked");
  else if (node.value !== null) parts.push(`= ${JSON.stringify(node.value)}`);

  // An option is only meaningful beside the control it belongs to, and a model
  // that has to infer the pairing from line order will eventually infer it wrong.
  if (node.ownerRef !== null) parts.push(`of ${node.ownerRef}`);

  const marks: string[] = [];
  if (node.kind !== "ordinary") marks.push(node.kind);
  if (node.disabled) marks.push("disabled");
  if (!node.inViewport) marks.push("off-screen");
  if (marks.length > 0) parts.push(`(${marks.join(", ")})`);

  return parts.join(" ");
}

/** The whole page, as an agent reads it. */
export function formatPageSnapshot(snapshot: PageSnapshot): string {
  if (snapshot.nodes.length === 0) {
    return "This page reports nothing to act on. It may still be loading, or it may draw itself in a way this snapshot cannot see; read_page may still work.";
  }

  const footer =
    snapshot.dropped === 0
      ? ""
      : `\n\n[${snapshot.dropped} further element${snapshot.dropped === 1 ? "" : "s"} not shown; this page has more than one snapshot returns.]`;

  return `${snapshot.nodes.length} element${snapshot.nodes.length === 1 ? "" : "s"}:\n${snapshot.nodes
    .map(formatNode)
    .join("\n")}${footer}`;
}

/** The short form used in an approval line, where a reference means nothing. */
export function describeNode(node: SnapshotNode): string {
  return node.name.length > 0 ? `the ${node.role} ${JSON.stringify(node.name)}` : `a ${node.role}`;
}

/* ------------------------------------------------------------------------- */
/* Diffing                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * What identifies "the same element" across two captures.
 *
 * Not the reference, which is positional and renumbers whenever anything above
 * it appears or goes. Role and name are what a person would use to say the
 * button is still there, and they are what survive a re-render that changes
 * nothing a user would notice.
 */
function identity(node: SnapshotNode): string {
  return `${node.role} ${node.name}`;
}

function state(node: SnapshotNode): string {
  return `${node.checked === null ? "" : String(node.checked)} ${node.value ?? ""} ${String(node.disabled)}`;
}

function describeState(node: SnapshotNode): string {
  if (node.checked !== null) return node.checked ? "checked" : "unchecked";
  if (node.value !== null) return JSON.stringify(node.value);
  return node.disabled ? "disabled" : "enabled";
}

/**
 * What changed between two captures, as lines a model can read.
 *
 * This is the evidence an action worked. A click that reported success and
 * changed nothing is the failure mode a browser agent has most often and can
 * least afford, and the only way to catch it is to look afterwards.
 *
 * Bounded, because a page that re-renders wholesale would otherwise return a
 * diff longer than the snapshot it came from.
 */
export function diffPageSnapshots(before: PageSnapshot, after: PageSnapshot): string {
  const lines: string[] = [];

  if (before.url !== after.url) lines.push(`> now at ${after.url}`);

  const beforeByIdentity = new Map<string, SnapshotNode[]>();
  for (const node of before.nodes) {
    const key = identity(node);
    const bucket = beforeByIdentity.get(key);
    if (bucket === undefined) beforeByIdentity.set(key, [node]);
    else bucket.push(node);
  }

  const afterByIdentity = new Map<string, SnapshotNode[]>();
  for (const node of after.nodes) {
    const key = identity(node);
    const bucket = afterByIdentity.get(key);
    if (bucket === undefined) afterByIdentity.set(key, [node]);
    else bucket.push(node);
  }

  let elided = 0;
  const push = (line: string): void => {
    if (lines.length >= MAX_DIFF_LINES) elided += 1;
    else lines.push(line);
  };

  for (const [key, afterNodes] of afterByIdentity) {
    const beforeNodes = beforeByIdentity.get(key) ?? [];

    for (let index = 0; index < afterNodes.length; index += 1) {
      const now = afterNodes[index] as SnapshotNode;
      const then = beforeNodes[index];

      if (then === undefined) {
        push(`+ ${formatNode(now)}`);
        continue;
      }

      if (state(then) !== state(now)) {
        push(`~ [${now.ref}] ${now.role} ${JSON.stringify(now.name)}: ${describeState(then)} -> ${describeState(now)}`);
      }
    }
  }

  for (const [key, beforeNodes] of beforeByIdentity) {
    const afterNodes = afterByIdentity.get(key) ?? [];
    for (let index = afterNodes.length; index < beforeNodes.length; index += 1) {
      const gone = beforeNodes[index] as SnapshotNode;
      push(`- ${gone.role} ${JSON.stringify(gone.name)}`);
    }
  }

  if (lines.length === 0) {
    return "Nothing on the page changed. The action may not have had the effect you expected.";
  }

  const footer = elided === 0 ? "" : `\n[${elided} further change${elided === 1 ? "" : "s"} not shown.]`;
  return `${lines.join("\n")}${footer}`;
}
