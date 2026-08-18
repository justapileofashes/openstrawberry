/**
 * Applies the tracking policy to the session every guest renders into.
 *
 * The policy itself lives in `../shared/tracking.js` as pure functions, so the
 * question "would this request be blocked" is answerable in a test without a
 * network stack. This class is the part that cannot be pure: it hooks
 * `webRequest`, keeps the per-page counts the chrome displays, and persists the
 * user's exceptions.
 *
 * Two things it deliberately does not do:
 *
 *   - **It does not record what was blocked.** Only a count per page. A list of
 *     blocked URLs is a browsing history with extra steps, and keeping one to
 *     power a privacy feature would be its own small betrayal.
 *   - **It does not fetch or update its list.** The list is shipped. A blocker
 *     that phones home for rules is a third-party network call on every launch.
 */
import { readFileSync } from "node:fs";
import {
  decideRequest,
  emptyTrackingSnapshot,
  emptyTrackingState,
  parseTrackingState,
  registrableDomain,
  hostOf,
  MAX_EXCEPTIONS,
  TRACKING_STATE_VERSION,
  type TrackingSnapshot
} from "../shared/tracking.js";
import { writeFileAtomically } from "./atomic-write.js";

/**
 * The slice of the tab engine the blocker needs.
 *
 * Narrow on purpose, and read-only: the blocker answers questions about tabs and
 * can do nothing to them.
 */
export interface TrackingBrowserPort {
  readonly pageForWebContents: (webContentsId: number) => { tabId: string; url: string } | null;
  readonly focusedTab: () => { tabId: string; url: string } | null;
}

/** The slice of Electron's webRequest this module uses. */
export interface WebRequestPort {
  readonly onBeforeRequest: (
    listener: (
      details: { readonly url: string; readonly webContentsId?: number },
      callback: (response: { cancel: boolean }) => void
    ) => void
  ) => void;
}

export interface TrackerBlockerOptions {
  readonly webRequest: WebRequestPort;
  readonly browser: TrackingBrowserPort;
  readonly statePath: string;
  readonly publish: (snapshot: TrackingSnapshot) => void;
}

/** Per-page counting state, reset when the page underneath changes. */
interface PageCount {
  readonly url: string;
  count: number;
}

export class TrackerBlocker {
  private readonly browser: TrackingBrowserPort;
  private readonly statePath: string;
  private readonly publish: (snapshot: TrackingSnapshot) => void;

  private enabled: boolean;
  private exceptions: Set<string>;

  /** Keyed by WebContents id, which is what a request is identified by. */
  private readonly counts = new Map<number, PageCount>();

  private destroyed = false;

  public constructor(options: TrackerBlockerOptions) {
    this.browser = options.browser;
    this.statePath = options.statePath;
    this.publish = options.publish;

    const restored = this.readState();
    this.enabled = restored.enabled;
    this.exceptions = new Set(restored.exceptions);

    options.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: this.shouldCancel(details) });
    });
  }

  /* --------------------------------------------------------------------- */
  /* The hot path                                                          */
  /* --------------------------------------------------------------------- */

  /**
   * Decides one request.
   *
   * Runs for every subresource of every page, so it stays allocation-light and
   * never throws: an exception here would stall loading rather than merely
   * mis-decide, so the failure mode is deliberately "allow".
   */
  private shouldCancel(details: {
    readonly url: string;
    readonly webContentsId?: number;
  }): boolean {
    if (this.destroyed || !this.enabled) return false;

    try {
      const webContentsId = details.webContentsId;
      if (webContentsId === undefined) return false;

      const page = this.browser.pageForWebContents(webContentsId);
      if (page === null) return false;

      const decision = decideRequest(details.url, page.url, {
        enabled: this.enabled,
        exceptions: this.exceptions
      });

      if (!decision.blocked) return false;

      this.record(webContentsId, page.url);
      return true;
    } catch {
      // A blocker that throws must not be a blocker that breaks the web.
      return false;
    }
  }

  /**
   * Counts a block against the page it happened on.
   *
   * The stored page URL is what resets the count: when a tab navigates, the URL
   * no longer matches and the counter starts again. Deriving the reset from the
   * page itself means no navigation event has to be wired up correctly for the
   * number to be right.
   */
  private record(webContentsId: number, pageUrl: string): void {
    const existing = this.counts.get(webContentsId);

    if (existing === undefined || existing.url !== pageUrl) {
      this.counts.set(webContentsId, { url: pageUrl, count: 1 });
    } else {
      existing.count += 1;
    }

    this.emit();
  }

  /* --------------------------------------------------------------------- */
  /* Commands                                                              */
  /* --------------------------------------------------------------------- */

  public setEnabled(enabled: boolean): TrackingSnapshot {
    this.enabled = enabled;
    this.persistQuietly();
    return this.emit();
  }

  /**
   * Stops blocking on the site the given tab is showing.
   *
   * Scoped to the registrable domain, so an exception a user grants on one page
   * of a site applies to the site. Granting it per-page would leave them
   * clicking the same button on every article.
   */
  public exceptSite(tabId: string): TrackingSnapshot {
    const site = this.siteForTab(tabId);
    if (site.length === 0 || this.exceptions.size >= MAX_EXCEPTIONS) return this.snapshot();

    this.exceptions.add(site);
    this.persistQuietly();
    return this.emit();
  }

  public resumeSite(tabId: string): TrackingSnapshot {
    const site = this.siteForTab(tabId);
    if (site.length === 0) return this.snapshot();

    this.exceptions.delete(site);
    this.persistQuietly();
    return this.emit();
  }

  /** Removes an exception by name, for the Settings list. */
  public removeException(site: string): TrackingSnapshot {
    this.exceptions.delete(site);
    this.persistQuietly();
    return this.emit();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      this.persistState();
    } catch {
      // Exceptions that cannot be written must never block a clean exit.
    }
    this.counts.clear();
  }

  /* --------------------------------------------------------------------- */
  /* Snapshot                                                              */
  /* --------------------------------------------------------------------- */

  public snapshot(): TrackingSnapshot {
    const focused = this.browser.focusedTab();
    if (focused === null) {
      return { ...emptyTrackingSnapshot(), enabled: this.enabled, exceptions: this.sortedExceptions() };
    }

    const site = registrableDomain(hostOf(focused.url));

    return {
      enabled: this.enabled,
      site,
      blockedOnPage: this.countFor(focused),
      siteExcepted: site.length > 0 && this.exceptions.has(site),
      exceptions: this.sortedExceptions()
    };
  }

  /* --------------------------------------------------------------------- */
  /* Internals                                                             */
  /* --------------------------------------------------------------------- */

  private emit(): TrackingSnapshot {
    const next = this.snapshot();
    if (!this.destroyed) this.publish(next);
    return next;
  }

  private sortedExceptions(): readonly string[] {
    return [...this.exceptions].sort();
  }

  private siteForTab(tabId: string): string {
    const focused = this.browser.focusedTab();
    // The tab named must be the one in front. A background tab's site is not
    // what the user is looking at when they click the control.
    if (focused === null || focused.tabId !== tabId) return "";
    return registrableDomain(hostOf(focused.url));
  }

  /** The count for a tab's *current* page, which a stale entry never supplies. */
  private countFor(focused: { tabId: string; url: string }): number {
    for (const entry of this.counts.values()) {
      if (entry.url === focused.url) return entry.count;
    }
    return 0;
  }

  private readState(): { enabled: boolean; exceptions: readonly string[] } {
    try {
      const text = readFileSync(this.statePath, "utf8").replace(/^\uFEFF/u, "");
      return parseTrackingState(JSON.parse(text) as unknown);
    } catch {
      return emptyTrackingState();
    }
  }

  private persistQuietly(): void {
    try {
      this.persistState();
    } catch {
      // Reported by the snapshot rather than claimed as saved.
    }
  }

  private persistState(): void {
    writeFileAtomically(
      this.statePath,
      JSON.stringify({
        version: TRACKING_STATE_VERSION,
        enabled: this.enabled,
        exceptions: this.sortedExceptions().slice(0, MAX_EXCEPTIONS)
      })
    );
  }
}
