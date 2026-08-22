/**
 * Running one browser tool call, in the trusted process.
 *
 * The contract - which tools exist, what they take, which of them need consent,
 * and how each result is worded - lives in `shared/browser-tools.ts`. This file
 * is only the part that has to touch a live page, and it keeps the same
 * discipline the reader and media modules established:
 *
 *   - The two scripts that run inside a guest page are constants held in this
 *     process. No string an agent supplied is ever evaluated, and the actions
 *     themselves evaluate nothing at all: a click is a mouse event at a rectangle
 *     this process captured, not a selector resolved in the page.
 *   - What a page hands back is untrusted JSON. `buildPageLinks` and
 *     `buildPageSnapshot` re-derive every field, and the http(s) gate is
 *     re-applied on the way out, so a page cannot put a `javascript:` address in
 *     front of an agent by declaring one.
 *   - What a page *says* is untrusted text. Every payload derived from one is
 *     wrapped by `trust-boundary.ts` before it reaches a model, so page content
 *     cannot arrive looking like an instruction.
 *   - A tab this run was not granted is refused before anything else happens, so
 *     an agent cannot learn that a tab exists by being told it may not touch it.
 *
 * The loop this serves is snapshot, act, verify. That is why every action ends
 * by re-capturing the page and returning a diff rather than by reporting that it
 * dispatched some events: a click that lands on nothing is the failure a browser
 * agent has most often, and the only way to catch it is to look afterwards.
 */
import { randomBytes } from "node:crypto";
import {
  approvalReason,
  approvalSummary,
  buildPageLinks,
  formatPageLinks,
  formatReaderDocument,
  formatTabList,
  interactsWithPage,
  mutatesBrowser,
  parseBrowserToolCall,
  stepRef,
  submitApprovalReason,
  submitApprovalSummary,
  targetTabOf,
  type ActStep,
  type BrowserToolCall
} from "../shared/browser-tools.js";
import type { BrowserPaneId, BrowserSnapshot, BrowserTabState } from "../shared/browser.js";
import { IpcValidationError } from "../shared/ipc-validation.js";
import type { McpToolResult } from "../shared/mcp.js";
import {
  diffPageSnapshots,
  formatPageSnapshot,
  nodeByRef,
  type PageSnapshot,
  type SnapshotNode
} from "../shared/page-snapshot.js";
import { TRUST_NONCE_BYTES, wrapUntrusted } from "../shared/trust-boundary.js";
import { extractReaderDocument, type ReaderContentsPort } from "./reader.js";
import { capturePageSnapshot, type SnapshotContentsPort } from "./page-snapshot.js";
import { captureScreenshot, type ScreenshotContentsPort } from "./browser-screenshot.js";
import {
  centreOf,
  clearField,
  clickAt,
  hoverAt,
  pressKey,
  scrollBy,
  selectOption,
  typeText,
  type DispatchOptions,
  type InputContentsPort
} from "./browser-input.js";
import { refFailureText, SnapshotRegistry } from "./snapshot-registry.js";

/**
 * Everything the tools do to one page, as one port.
 *
 * Assembled from the four modules that each own a piece of it, so the set of
 * things this feature can do to a page is the union of four short interfaces
 * rather than "a WebContents". A real `WebContents` satisfies it.
 */
export interface PageContentsPort
  extends ReaderContentsPort,
    SnapshotContentsPort,
    InputContentsPort,
    ScreenshotContentsPort {}

/**
 * The slice of the tab engine the tools need.
 *
 * Declared structurally rather than importing the manager, so this module has no
 * Electron dependency and the whole executor is testable against a plain object.
 * `AgentManager`'s `BrowserPort` satisfies it.
 */
export interface BrowserToolPort {
  readonly snapshot: () => BrowserSnapshot;
  readonly createTab: (paneId: BrowserPaneId, url: string) => BrowserSnapshot;
  readonly closeTab: (tabId: string) => BrowserSnapshot;
  readonly navigate: (tabId: string, address: string) => BrowserSnapshot;
  readonly goBack: (tabId: string) => BrowserSnapshot;
  readonly goForward: (tabId: string) => BrowserSnapshot;
  readonly reload: (tabId: string) => BrowserSnapshot;
  readonly contentsFor: (tabId: string) => PageContentsPort | null;
  /**
   * A counter the tab engine bumps on every navigation, in-page ones included.
   *
   * This is what makes an element reference expire. Without it a reference from
   * before a navigation still resolves, to whatever now happens to be in that
   * position - which is not a miss, it is a confident click on the wrong thing.
   */
  readonly generationFor: (tabId: string) => number;
  /**
   * The size the tab is currently drawn at, or null when it is not drawn.
   *
   * This app detaches the views of inactive panes, and a view that is not
   * composited has no geometry: every rectangle in it is zero, so every click
   * would land at the origin. Asking first turns that into a refusal an agent
   * can understand instead of a run that quietly clicks nothing.
   */
  readonly viewportFor: (tabId: string) => { readonly width: number; readonly height: number } | null;
}

/**
 * One agent's authority over the browser, for the length of one run.
 *
 * `granted` is the whole of what this run may see: the tabs the user picked when
 * they started it, plus any tab the run itself opened. It is a question rather
 * than a set so the answer stays live - a tab closed mid-run stops being
 * readable without anything having to remember to revoke it.
 */
export interface BrowserToolSession {
  readonly agentName: string;
  readonly granted: (tabId: string) => boolean;
  readonly grant: (tabId: string) => void;
  /**
   * The tabs this run opened for itself.
   *
   * Kept apart from the tabs the user granted so `list_tabs` can say which is
   * which. One of them the user is looking at and the other the agent made, and
   * an agent told the difference tidies up after itself and leaves theirs alone.
   */
  readonly ownTabs: () => ReadonlySet<string>;
  /**
   * Stops for the user, and resolves with what they said.
   *
   * A denial is an ordinary answer, not an exception: the tool reports it back
   * to the agent as a failed call so it can choose another route rather than
   * dying on a "no".
   */
  readonly approve: (
    toolName: string,
    summary: string,
    reason: string,
    tabId: string | null
  ) => Promise<boolean>;
  /**
   * Whether this run may touch pages at all. Asked once and remembered.
   *
   * The one gate that is not per-action, because per-action is what it would
   * have to be otherwise and a person asked to approve every keystroke stops
   * reading the question. Implemented by the caller, which is what memoises it.
   */
  readonly mayInteract: () => Promise<boolean>;
  /**
   * This run's captured pages.
   *
   * Held on the session rather than beside the browser so that a signed-in
   * page's field values die when the run does, and so two runs cannot resolve
   * each other's references.
   */
  readonly snapshots: SnapshotRegistry;
}

/**
 * Runs a `run` script. Absent in builds and tests that do not offer the tool.
 *
 * Injected rather than imported so this module keeps no Electron dependency:
 * the sandbox is a hidden window, and a window cannot be constructed in a unit
 * test. `callTool` is handed back so everything the script does re-enters this
 * file through the same front door an agent's own call does.
 */
export interface ScriptRunnerPort {
  readonly run: (
    script: string,
    callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>
  ) => Promise<McpToolResult>;
}

/** Injected so the settle wait is a parameter of a test rather than a delay in one. */
export interface BrowserToolOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly settleTimeoutMs?: number;
  readonly scriptRunner?: ScriptRunnerPort;
}

/** How long a navigation is given to finish before the tool reports what it has. */
export const SETTLE_TIMEOUT_MS = 15_000;

/** How often the tab is re-read while waiting, and how many still polls end it. */
const SETTLE_POLL_MS = 150;
const SETTLE_QUIET_POLLS = 3;

/** How often `wait_for` looks again while waiting for text. */
const TEXT_POLL_MS = 500;

/**
 * The in-page link scan.
 *
 * A constant, evaluated in a context this process does not control and cannot
 * import into, so it depends on nothing outside itself. `a.href` is read rather
 * than the `href` attribute because the DOM property resolves against the
 * document's base URL, which is what turns a relative link into something an
 * agent can actually navigate to.
 *
 * The bounds here are the page's courtesy limit. The real ones are applied again
 * on this side by `buildPageLinks`, because a page can return whatever it likes
 * however politely this script asks.
 */
const LINKS_SCRIPT = `(() => {
  try {
    const out = [];
    const seen = new Set();

    for (const anchor of document.querySelectorAll("a[href]")) {
      if (out.length >= 200) break;

      const href = anchor.href;
      if (typeof href !== "string") continue;
      if (!href.startsWith("http:") && !href.startsWith("https:")) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const label =
        anchor.textContent ||
        anchor.getAttribute("aria-label") ||
        anchor.getAttribute("title") ||
        "";

      out.push({
        url: href.slice(0, 4096),
        text: String(label).replace(/\\s+/g, " ").trim().slice(0, 200)
      });
    }

    return out;
  } catch {
    /* A page that throws while being scanned simply has no links to offer. */
    return [];
  }
})()`;

function ok(text: string): McpToolResult {
  return { text, isError: false, image: null };
}

function failed(text: string): McpToolResult {
  return { text, isError: true, image: null };
}

/**
 * Wraps a payload a page produced, with a nonce it cannot have guessed.
 *
 * Every page-derived result goes through here. The nonce is minted per call, so
 * text on a page cannot close the block it is inside and continue at the
 * instruction level.
 */
function fromPage(text: string): McpToolResult {
  return ok(wrapUntrusted(text, randomBytes(TRUST_NONCE_BYTES).toString("hex")));
}

function tabOf(snapshot: BrowserSnapshot, tabId: string): BrowserTabState | null {
  return snapshot.tabs.find((tab) => tab.id === tabId) ?? null;
}

function describeTab(tab: BrowserTabState): string {
  return `${tab.id}\t${tab.title}\t${tab.url}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Waits for a tab to stop loading, then reports it.
 *
 * A navigation is asynchronous, so a tool that returned the instant it asked for
 * one would hand back the address the tab was at a moment ago and leave the
 * agent to read a page that has not arrived. Bounded, because a page that never
 * finishes loading is common and is not a reason to hang a tool call: the tab is
 * reported as it stands when the budget runs out.
 *
 * Null means the tab went away while waiting, which closing one legitimately
 * does.
 */
async function settle(
  port: BrowserToolPort,
  tabId: string,
  options: BrowserToolOptions
): Promise<BrowserTabState | null> {
  const sleep = options.sleep ?? defaultSleep;
  const budget = options.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  const deadline = Date.now() + budget;

  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);

    const tab = tabOf(port.snapshot(), tabId);
    if (tab === null) return null;

    if (tab.isLoading) {
      quiet = 0;
      continue;
    }

    quiet += 1;
    if (quiet >= SETTLE_QUIET_POLLS) return tab;
  }

  return tabOf(port.snapshot(), tabId);
}

/**
 * Takes a capture and files it against the tab.
 *
 * The generation is read before the capture rather than after, so a navigation
 * that happens while the page is being walked produces a snapshot filed under
 * the generation it was actually taken in - which the next call then sees as
 * stale, correctly, rather than trusting it under the new one.
 */
async function captureAndRemember(
  port: BrowserToolPort,
  session: BrowserToolSession,
  tabId: string,
  contents: PageContentsPort
): Promise<PageSnapshot> {
  const generation = port.generationFor(tabId);
  const snapshot = await capturePageSnapshot(contents, generation);
  session.snapshots.remember(tabId, snapshot);
  return snapshot;
}

/**
 * Runs a call named the way a model names one: a string and a bag.
 *
 * The single entrance both transports use. An MCP client sends a name and an
 * arguments object over a socket; a model on an API key produces exactly the
 * same two things inside a reply. Parsing them in one place is what makes the
 * closed tool set, the grant boundary, and the approval gate identical for both
 * rather than similar.
 *
 * A malformed argument comes back as a failed tool result rather than as a
 * thrown error, because the audience for it is the model that got it wrong. The
 * wording is safe to hand on: the validators name the field and the expectation
 * and never echo the value they rejected.
 */
export async function runNamedBrowserTool(
  port: BrowserToolPort,
  session: BrowserToolSession,
  name: string,
  args: Record<string, unknown>,
  options: BrowserToolOptions = {}
): Promise<McpToolResult> {
  let call: BrowserToolCall;
  try {
    call = parseBrowserToolCall(name, args);
  } catch (error) {
    return failed(
      error instanceof IpcValidationError ? error.message : "That call could not be read."
    );
  }

  try {
    return await runBrowserTool(port, session, call, options);
  } catch {
    // The executor is documented never to throw. Treating a broken one as a
    // failed call keeps a run from dying on a contract violation.
    return failed("That tool did not complete.");
  }
}

/**
 * Runs one validated call and returns what the agent should be told.
 *
 * Never throws. Every refusal - an unknown tab, a tab this run may not touch, a
 * page that would not answer, a user who said no - comes back as a tool result
 * marked as an error, because all of those are things the agent can react to and
 * none of them is a protocol failure.
 */
export async function runBrowserTool(
  port: BrowserToolPort,
  session: BrowserToolSession,
  call: BrowserToolCall,
  options: BrowserToolOptions = {}
): Promise<McpToolResult> {
  /*
   * The grant check comes first, and covers reads and writes alike. Asking the
   * user to approve an action on a tab the run was never given would be a gate
   * that can only ever be answered wrongly.
   */
  const target = targetTabOf(call);
  if (target !== null) {
    if (tabOf(port.snapshot(), target) === null) {
      return failed(`There is no tab ${target}. Call list_tabs for the tabs available.`);
    }
    if (!session.granted(target)) {
      return failed(
        `This run was not granted ${target}. Ask the user to include that tab, or work with the tabs list_tabs reports.`
      );
    }
  }

  if (mutatesBrowser(call.name)) {
    const allowed = await session.approve(
      call.name,
      approvalSummary(call, session.agentName),
      approvalReason(call),
      target
    );
    if (!allowed) {
      return failed(
        "The user declined this action. Do not retry it; carry on without it, or tell them what you would need."
      );
    }
  }

  /*
   * Touching a page is asked once for the whole run rather than once per act.
   * The caller memoises it, so this is a question the first time and a stored
   * answer afterwards.
   */
  if (interactsWithPage(call.name)) {
    const allowed = await session.mayInteract();
    if (!allowed) {
      return failed(
        "The user did not allow this run to interact with pages. You can still read them; say what you would have needed to do rather than looking for another way."
      );
    }
  }

  switch (call.name) {
    case "list_tabs": {
      const visible = port.snapshot().tabs.filter((tab) => session.granted(tab.id));
      return ok(formatTabList(visible, session.ownTabs()));
    }

    case "snapshot": {
      const contents = port.contentsFor(call.tabId);
      if (contents === null) return failed("That tab has no live page to read.");

      const snapshot = await captureAndRemember(port, session, call.tabId, contents);
      return fromPage(`${snapshot.url}\n${formatPageSnapshot(snapshot)}`);
    }

    case "read_page": {
      const contents = port.contentsFor(call.tabId);
      if (contents === null) return failed("That tab has no live page to read.");

      const state = await extractReaderDocument(contents);
      if (state.status !== "ready") {
        return failed(
          "That page has no readable article. It may be an application rather than a document, or it may still be loading."
        );
      }

      return fromPage(formatReaderDocument(state.document));
    }

    case "page_links": {
      const contents = port.contentsFor(call.tabId);
      if (contents === null) return failed("That tab has no live page to read.");

      let raw: unknown;
      try {
        raw = await contents.executeJavaScript(LINKS_SCRIPT);
      } catch {
        return failed("That page could not be read.");
      }

      return fromPage(formatPageLinks(buildPageLinks(raw)));
    }

    case "screenshot": {
      const contents = port.contentsFor(call.tabId);
      if (contents === null) return failed("That tab has no live page to capture.");

      const shot = await captureScreenshot(contents);
      if (shot === null) {
        return failed("That page could not be captured. It may not be on screen, or it may be too large to send.");
      }

      const tab = tabOf(port.snapshot(), call.tabId);
      return {
        text: wrapUntrusted(
          `A screenshot of ${tab === null ? call.tabId : tab.url}, ${String(shot.width)} by ${String(shot.height)}.`,
          randomBytes(TRUST_NONCE_BYTES).toString("hex")
        ),
        isError: false,
        image: { mediaType: shot.mediaType, data: shot.data }
      };
    }

    case "act":
      return runAct(port, session, call.tabId, call.steps, options);

    case "wait_for":
      return runWait(port, session, call, options);

    case "run": {
      const runner = options.scriptRunner;
      if (runner === undefined) {
        return failed("This build cannot run scripts. Call the tools directly instead.");
      }

      return runner.run(call.script, (name, args) =>
        // Straight back through the front door, so a script has exactly the
        // authority the agent running it has - same closed set, same grants,
        // same gates - and no separate path to keep in step with this one.
        runNamedBrowserTool(port, session, name, args, options)
      );
    }

    case "open_tab": {
      const before = new Set(port.snapshot().tabs.map((tab) => tab.id));
      const after = port.createTab(call.pane, call.url);
      const opened = after.tabs.find((tab) => !before.has(tab.id)) ?? null;

      if (opened === null) {
        return failed("The browser would not open another tab. It may be at its tab limit.");
      }

      // The run may read what it just opened. Granting on the way out rather
      // than on the way in means a refused open grants nothing.
      session.grant(opened.id);

      const settled = await settle(port, opened.id, options);
      return ok(
        settled === null
          ? `Opened ${opened.id}, but it is no longer open.`
          : `Opened ${describeTab(settled)}`
      );
    }

    case "navigate_tab": {
      port.navigate(call.tabId, call.url);
      // A navigation retires every reference into the old page. Dropping the
      // capture here means the next act is told to look again rather than
      // resolving against a document that has gone.
      session.snapshots.forget(call.tabId);
      const settled = await settle(port, call.tabId, options);
      return ok(
        settled === null ? "That tab closed while it was loading." : `Now at ${describeTab(settled)}`
      );
    }

    case "close_tab": {
      port.closeTab(call.tabId);
      session.snapshots.forget(call.tabId);
      return ok(`Closed ${call.tabId}.`);
    }

    case "go_back":
    case "go_forward":
    case "reload_tab": {
      if (call.name === "go_back") port.goBack(call.tabId);
      else if (call.name === "go_forward") port.goForward(call.tabId);
      else port.reload(call.tabId);

      session.snapshots.forget(call.tabId);
      const settled = await settle(port, call.tabId, options);
      return ok(
        settled === null ? "That tab closed while it was loading." : `Now at ${describeTab(settled)}`
      );
    }
  }
}

/* ------------------------------------------------------------------------- */
/* act                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * What one step is refused for, or null when it may go ahead.
 *
 * Every answer here is decided from the element rather than from the act,
 * because the act only ever says "click" and the element is the only thing that
 * knows whether that click submits a form, opens a file picker, or is ordinary.
 */
function refusalFor(
  step: ActStep,
  node: SnapshotNode,
  snapshot: PageSnapshot
): string | null {
  if (node.kind === "file") {
    return "That is a file picker. Choosing a file is the user's to do, and no agent here may do it for them.";
  }

  if ((step.kind === "type" || step.kind === "fill") && node.kind === "password") {
    return "That is a password field. This browser never types a credential on your behalf; ask the user to enter it themselves.";
  }

  if (node.disabled) {
    return `${node.ref} is disabled. Something else on the page has to change before it can be used.`;
  }

  if (step.kind === "select") {
    if (node.role !== "option") {
      return `${node.ref} is not an option. Name the option you want, not the control it belongs to.`;
    }
    if (node.ownerRef === null || node.optionIndex === null) {
      return `${node.ref} is not part of a list this can choose from.`;
    }

    /*
     * An option is never on screen in its own right - a native list is drawn by
     * the operating system, outside the page - so what has to be reachable is
     * the control it belongs to, which is what gets clicked to open it.
     */
    const owner = nodeByRef(snapshot, node.ownerRef);
    if (owner === null) {
      return `The list ${node.ref} belongs to is no longer in the snapshot. Take a fresh one.`;
    }
    if (owner.disabled) return `${owner.ref} is disabled, so its options cannot be changed.`;
    if (!owner.inViewport) {
      return `${owner.ref} is not on screen, so its list cannot be opened. Scroll towards it, then take a fresh snapshot.`;
    }
    return null;
  }

  if (step.kind === "check" || step.kind === "uncheck") {
    if (node.checked === null) {
      return `${node.ref} is not something that can be checked or unchecked.`;
    }
  }

  // Scroll aims at the middle of the viewport and needs no element; everything
  // else has to be somewhere a pointer can reach.
  if (!node.inViewport) {
    return `${node.ref} is not on screen, so there is nowhere to click. Scroll towards it, then take a fresh snapshot.`;
  }

  return null;
}

/** Whether this step is the one act that cannot be taken back. */
function submits(step: ActStep, node: SnapshotNode | null): boolean {
  if (step.kind === "click") return node !== null && node.kind === "submit";
  if (step.kind !== "press" || step.key !== "Enter") return false;
  // Enter is the submit key. With no element named there is no way to know what
  // has focus, so the cautious reading is the one taken.
  return node === null || node.inForm || node.kind === "submit";
}

async function runAct(
  port: BrowserToolPort,
  session: BrowserToolSession,
  tabId: string,
  steps: readonly ActStep[],
  options: BrowserToolOptions
): Promise<McpToolResult> {
  const contents = port.contentsFor(tabId);
  if (contents === null) return failed("That tab has no live page to act on.");

  const viewport = port.viewportFor(tabId);
  if (viewport === null || viewport.width <= 0 || viewport.height <= 0) {
    return failed(
      "That tab is not on screen, so there is nothing to click. Ask the user to bring it to the front, or work in a tab that is visible."
    );
  }

  const generation = port.generationFor(tabId);
  const before = session.snapshots.current(tabId, generation);
  if (before === null) {
    /*
     * Two different failures with two different next moves. An agent that never
     * looked has to snapshot; an agent whose page moved under it has to snapshot
     * again and expect the references to have changed. Telling it the first when
     * it is the second sends it round the same loop.
     */
    return failed(
      session.snapshots.freshness(tabId, generation) === "stale"
        ? refFailureText({ status: "stale" }, "")
        : "You have not taken a snapshot of that tab. Call snapshot first; the references it returns are the only ones act accepts."
    );
  }

  const done: string[] = [];

  for (const step of steps) {
    const ref = stepRef(step);
    let node: SnapshotNode | null = null;

    if (ref !== null) {
      const resolution = session.snapshots.resolve(tabId, port.generationFor(tabId), ref);
      if (resolution.status !== "ok") {
        return partial(done, refFailureText(resolution, ref));
      }
      node = resolution.node;

      const refused = refusalFor(step, node, resolution.snapshot);
      if (refused !== null) return partial(done, refused);
    }

    if (submits(step, node)) {
      const allowed = await session.approve(
        "act",
        node === null
          ? `${session.agentName} wants to submit a form`
          : submitApprovalSummary(session.agentName, node),
        submitApprovalReason(),
        tabId
      );
      if (!allowed) {
        return partial(
          done,
          "The user declined to submit. Do not retry it; tell them what is ready to send and let them do it."
        );
      }
    }

    await dispatch(contents, step, node, before, viewport, options);
    done.push(describeStep(step, node));
  }

  /*
   * The verification half of the loop. Everything above only says that events
   * were dispatched; this is the part that says whether anything happened.
   */
  const settled = await settle(port, tabId, options);
  if (settled === null) return ok(`${done.join("\n")}\n\nThat tab closed.`);

  const contentsAfter = port.contentsFor(tabId);
  if (contentsAfter === null) return ok(`${done.join("\n")}\n\nThat tab is no longer readable.`);

  const after = await captureAndRemember(port, session, tabId, contentsAfter);

  return fromPage(
    `${done.join("\n")}\n\nWhat changed:\n${diffPageSnapshots(before, after)}\n\nReferences have been renumbered; the ones below are current.\n${formatPageSnapshot(after)}`
  );
}

/** A refusal partway through a batch, saying what did happen before it. */
function partial(done: readonly string[], reason: string): McpToolResult {
  return failed(
    done.length === 0
      ? reason
      : `${done.join("\n")}\n\nThen stopped: ${reason}\nThe steps above did happen; take a fresh snapshot before continuing.`
  );
}

function describeStep(step: ActStep, node: SnapshotNode | null): string {
  const where = node === null ? "" : ` ${node.ref}`;
  switch (step.kind) {
    case "click":
      return `Clicked${where}.`;
    case "hover":
      return `Hovered${where}.`;
    case "type":
      return `Typed into${where}.`;
    case "fill":
      return `Replaced the contents of${where}.`;
    case "press":
      return `Pressed ${step.key}${where}.`;
    case "scroll":
      return `Scrolled ${step.direction}.`;
    case "check":
      return `Checked${where}.`;
    case "uncheck":
      return `Unchecked${where}.`;
    case "select":
      return `Chose${where}.`;
  }
}

async function dispatch(
  contents: PageContentsPort,
  step: ActStep,
  node: SnapshotNode | null,
  snapshot: PageSnapshot,
  viewport: { readonly width: number; readonly height: number },
  options: BrowserToolOptions
): Promise<void> {
  // Rebuilt rather than spread: an explicit `sleep: undefined` is a different
  // thing from an absent one under this project's strict optional-property rule.
  const dispatchOptions: DispatchOptions =
    options.sleep === undefined ? {} : { sleep: options.sleep };
  const point = node === null ? null : centreOf(node.rect);

  switch (step.kind) {
    case "hover":
      if (point !== null) await hoverAt(contents, point, dispatchOptions);
      return;

    case "click":
      if (point !== null) await clickAt(contents, point, dispatchOptions);
      return;

    case "type":
      if (point !== null) await clickAt(contents, point, dispatchOptions);
      await typeText(contents, step.text, dispatchOptions);
      return;

    case "fill":
      if (point !== null) await clickAt(contents, point, dispatchOptions);
      await clearField(contents, dispatchOptions);
      await typeText(contents, step.text, dispatchOptions);
      return;

    case "press":
      if (point !== null) await clickAt(contents, point, dispatchOptions);
      await pressKey(contents, step.key, dispatchOptions);
      return;

    case "scroll":
      await scrollBy(
        contents,
        { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) },
        step.direction,
        step.amount,
        dispatchOptions
      );
      return;

    case "check":
    case "uncheck": {
      if (point === null || node === null) return;
      // Clicking a checkbox toggles it, so a click is only correct when the box
      // is not already where it was asked to be. Reading the state first is what
      // makes check idempotent, which is what a model expects of a word like it.
      const wanted = step.kind === "check";
      if (node.checked !== wanted) await clickAt(contents, point, dispatchOptions);
      return;
    }

    case "select": {
      if (node === null || node.ownerRef === null || node.optionIndex === null) return;
      const owner = nodeByRef(snapshot, node.ownerRef);
      if (owner === null) return;

      await clickAt(contents, centreOf(owner.rect), dispatchOptions);
      await selectOption(
        contents,
        owner.optionIndex ?? 0,
        node.optionIndex,
        dispatchOptions
      );
      await pressKey(contents, "Enter", dispatchOptions);
      return;
    }
  }
}

/* ------------------------------------------------------------------------- */
/* wait_for                                                                   */
/* ------------------------------------------------------------------------- */

async function runWait(
  port: BrowserToolPort,
  session: BrowserToolSession,
  call: Extract<BrowserToolCall, { name: "wait_for" }>,
  options: BrowserToolOptions
): Promise<McpToolResult> {
  if (call.until === "idle") {
    const settled = await settle(port, call.tabId, {
      ...options,
      settleTimeoutMs: call.timeoutMs
    });
    return settled === null
      ? failed("That tab closed while waiting.")
      : ok(`Settled at ${describeTab(settled)}`);
  }

  const wanted = (call.text ?? "").toLowerCase();
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + call.timeoutMs;

  while (Date.now() < deadline) {
    const contents = port.contentsFor(call.tabId);
    if (contents === null) return failed("That tab closed while waiting.");

    /*
     * Matched in this process rather than in the page. A tool that took the
     * text into a script would be a tool that evaluates a string the agent
     * supplied, which is the one thing this whole surface is built to not have.
     */
    const snapshot = await captureAndRemember(port, session, call.tabId, contents);
    const inSnapshot = snapshot.nodes.some((node) => node.name.toLowerCase().includes(wanted));

    if (inSnapshot || snapshot.title.toLowerCase().includes(wanted)) {
      return fromPage(`Found it.\n${formatPageSnapshot(snapshot)}`);
    }

    const article = await extractReaderDocument(contents);
    if (
      article.status === "ready" &&
      article.document.blocks.some((block) => block.text.toLowerCase().includes(wanted))
    ) {
      return fromPage(`Found it in the page text.\n${formatPageSnapshot(snapshot)}`);
    }

    await sleep(TEXT_POLL_MS);
  }

  return failed(
    "That text did not appear before the wait ran out. Take a snapshot to see what is actually there."
  );
}
