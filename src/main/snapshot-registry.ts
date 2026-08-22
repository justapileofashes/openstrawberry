/**
 * Which element references are still worth anything.
 *
 * A reference like `e12` means "the twelfth thing in the list I gave you". That
 * sentence has a silent clause: *in the list I gave you a moment ago, about the
 * page that was open then*. Once the page navigates or re-renders, `e12` still
 * parses, still resolves to a rect, and now points at whatever happens to be
 * twelfth on a different page. An agent acting on it is not confused - it is
 * confident and wrong, which is the worse of the two.
 *
 * So a reference is only usable while the capture that minted it is. This module
 * is the only place that decides, and it decides on two facts:
 *
 *   1. **The tab has not navigated.** Every tab carries a counter the browser
 *      bumps on navigation, including in-page navigation, which is what a single
 *      page application does instead of loading a document. A counter that moved
 *      invalidates every reference for that tab at once.
 *
 *   2. **The capture is recent.** Navigation is not the only way a page changes;
 *      a live feed rearranges itself with no navigation at all. A time bound
 *      cannot catch that reliably, but it bounds how wrong a reference can get,
 *      and it costs one extra capture to be right.
 *
 * Neither check makes acting on a stale reference impossible - a page can
 * re-render inside the window - which is why every action ends by re-capturing
 * and returning a diff. This module reduces the cases; the diff catches the rest.
 */
import type { PageSnapshot, SnapshotNode } from "../shared/page-snapshot.js";

/**
 * How long a capture stays usable.
 *
 * Long enough that a model can look, think, and act without paying for a second
 * capture; short enough that a page which quietly rearranged itself is caught
 * before an action lands on the wrong thing.
 */
export const SNAPSHOT_TTL_MS = 30_000;

/** What resolving a reference can produce. */
export type RefResolution =
  | { readonly status: "ok"; readonly node: SnapshotNode; readonly snapshot: PageSnapshot }
  | { readonly status: "stale" }
  | { readonly status: "no-snapshot" }
  | { readonly status: "unknown-ref"; readonly snapshot: PageSnapshot };

/**
 * The most recent capture per tab, and nothing else.
 *
 * One entry per tab rather than a history: an older capture is a strictly worse
 * answer to every question this is asked, and keeping one would mean keeping a
 * signed-in page's contents in memory after the agent had moved on.
 */
export class SnapshotRegistry {
  private readonly snapshots = new Map<string, PageSnapshot>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: { readonly ttlMs?: number; readonly now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  public remember(tabId: string, snapshot: PageSnapshot): void {
    this.snapshots.set(tabId, snapshot);
  }

  /** The last capture for a tab if it is still current, else null. */
  public current(tabId: string, generation: number): PageSnapshot | null {
    const snapshot = this.snapshots.get(tabId);
    if (snapshot === undefined) return null;
    if (snapshot.generation !== generation) return null;
    if (this.now() - snapshot.capturedAt > this.ttlMs) return null;
    return snapshot;
  }

  /**
   * Whether this tab has a usable capture, told apart from having none.
   *
   * Asked before a batch of actions, where there is no single reference to
   * resolve yet and the two failures need different words: an agent that never
   * looked has to snapshot, and an agent whose page moved under it has to
   * snapshot *again* and expect different references. Answering both with the
   * same sentence sends the second one round the same loop.
   */
  public freshness(tabId: string, generation: number): "fresh" | "stale" | "none" {
    const stored = this.snapshots.get(tabId);
    if (stored === undefined) return "none";
    if (stored.generation !== generation) return "stale";
    return this.now() - stored.capturedAt > this.ttlMs ? "stale" : "fresh";
  }

  /**
   * Resolves a reference, distinguishing the three ways it can fail.
   *
   * They are told apart because the agent's next move differs for each: a stale
   * reference means capture again, an unknown one means the reference was
   * invented or mistyped, and no snapshot at all means it never looked.
   */
  public resolve(tabId: string, generation: number, ref: string): RefResolution {
    const stored = this.snapshots.get(tabId);
    if (stored === undefined) return { status: "no-snapshot" };

    if (stored.generation !== generation || this.now() - stored.capturedAt > this.ttlMs) {
      // Dropped rather than kept: nothing will ask for it again, and it holds a
      // signed-in page's field values.
      this.snapshots.delete(tabId);
      return { status: "stale" };
    }

    const node = stored.nodes.find((entry) => entry.ref === ref);
    return node === undefined
      ? { status: "unknown-ref", snapshot: stored }
      : { status: "ok", node, snapshot: stored };
  }

  /** Called when a tab closes, so a page's contents do not outlive its tab. */
  public forget(tabId: string): void {
    this.snapshots.delete(tabId);
  }

  public clear(): void {
    this.snapshots.clear();
  }
}

/** The wording each failure is reported to an agent with. */
export function refFailureText(resolution: RefResolution, ref: string): string {
  switch (resolution.status) {
    case "stale":
      return "Those references are from an earlier page. The tab has navigated or the capture has aged out; call snapshot again and use the references it returns.";
    case "no-snapshot":
      return "You have not taken a snapshot of that tab. Call snapshot first; the references it returns are the only ones act accepts.";
    case "unknown-ref":
      return `There is no ${ref} in the last snapshot of that tab. Call snapshot again and use a reference it reports.`;
    case "ok":
      return "";
  }
}
