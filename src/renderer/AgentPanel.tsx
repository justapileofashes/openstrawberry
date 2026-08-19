import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, SlidersHorizontal, Square, X } from "lucide-react";
import {
  activeCompanion as findActiveCompanion,
  pendingApproval as findPendingApproval,
  type AgentSnapshot
} from "../shared/agents.js";
import type { BrowserSnapshot } from "../shared/browser.js";
import { displayHostname } from "../shared/navigation.js";
import { tabAccessibleName } from "./browser-chrome.js";
import { CommandCenter } from "./CommandCenter.js";
import { routeSummary } from "./command-center.js";
import {
  canSubmitTask,
  configState,
  defaultContextTabIds,
  encryptionNotice,
  formatStepTime,
  isRunAdvancing,
  statusLabel,
  stepTone,
  toggleContextTab,
  visibleRun
} from "./agent-chrome.js";

/**
 * The companion surface.
 *
 * It is a real grid column rather than a sheet over the page. Pages are native
 * views the compositor draws above the DOM, so anything positioned over a pane
 * renders *behind* the page — the panel has to take space the pane gives up, and
 * the chrome's `ResizeObserver` then re-reports the smaller viewport.
 */
export function AgentPanel({
  snapshot,
  browser,
  onClose
}: {
  /*
   * Passed in rather than subscribed to here. A new tab draws the same command
   * center from the same state, and two subscriptions to one pushed snapshot is
   * two chances for the roster on screen to disagree with itself.
   */
  readonly snapshot: AgentSnapshot;
  readonly browser: BrowserSnapshot;
  readonly onClose: () => void;
}): React.JSX.Element {
  const bridge = window.openstrawberry.agents;
  const [task, setTask] = useState("");
  const [contextTabIds, setContextTabIds] = useState<readonly string[]>(() =>
    defaultContextTabIds(browser)
  );
  const [commandCenterOpen, setCommandCenterOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const run = useMemo(() => visibleRun(snapshot), [snapshot]);
  const status = run?.status ?? null;
  const approval = useMemo(() => findPendingApproval(snapshot), [snapshot]);
  const companion = useMemo(() => findActiveCompanion(snapshot), [snapshot]);

  // Follow the transcript as steps arrive, the way a log pane is expected to.
  useEffect(() => {
    const element = logRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [run?.steps.length, approval]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (companion === null || !canSubmitTask(task, status)) return;
      void bridge.startRun(companion.id, task.trim(), contextTabIds);
      setTask("");
    },
    [bridge, companion, task, status, contextTabIds]
  );

  const submittable = canSubmitTask(task, status);
  const config = snapshot.config;
  const provider = configState(config);

  // Non-null exactly when no key can be stored, which is exactly when
  // `configState` reports `unavailable` — one decision, read two ways.
  const notice = encryptionNotice(config);

  return (
    <aside className="agent glass" role="complementary" aria-label="Agent companion">
      <header className="set-head">
        <div>
          <span className="eyebrow">{companion?.role ?? "companion"}</span>
          <h2>{companion?.name ?? "Companion"}</h2>
        </div>
        <div className="agent-head-tools">
          <span className="agent-status" data-status={status ?? "idle"}>
            {statusLabel(status)}
          </span>
          <button
            type="button"
            className={`icon-btn${commandCenterOpen ? " is-on" : ""}`}
            onClick={() => setCommandCenterOpen((open) => !open)}
            aria-label={commandCenterOpen ? "Close command center" : "Open command center"}
            aria-expanded={commandCenterOpen}
          >
            <SlidersHorizontal size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close agents"
          >
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>

      {/*
        Over the panel rather than beside it. The panel is already a column the
        page gave up its width for, so opening the command center must not take
        more and slide the page out from under the user.
      */}
      {commandCenterOpen && (
        <CommandCenter snapshot={snapshot} onClose={() => setCommandCenterOpen(false)} />
      )}

      <div className="set-body agent-log" ref={logRef}>
        {run === null ? (
          <p className="agent-empty">
            Give {companion?.name ?? "your companion"} a task. It reads the tabs you
            share and asks before anything leaves the browser.
          </p>
        ) : (
          <ol className="agent-steps">
            {run.steps.map((step) => (
              <li key={step.id} className="agent-step" data-tone={stepTone(step.kind)}>
                <span className="agent-step-time">{formatStepTime(step.at)}</span>
                <div className="agent-step-body">
                  <span className="agent-step-label">{step.label}</span>
                  {step.detail !== null && (
                    <pre className="agent-step-detail">{step.detail}</pre>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {approval !== null && (
        <div className="agent-approve" role="alertdialog" aria-label="Approval required">
          <span className="eyebrow">Approval required</span>
          <p className="agent-approve-summary">{approval.summary}</p>
          <p className="agent-approve-reason">{approval.reason}</p>
          <div className="agent-approve-actions">
            <button
              type="button"
              className="agent-btn is-deny"
              onClick={() => void bridge.resolveApproval(approval.id, "deny")}
            >
              Deny
            </button>
            <button
              type="button"
              className="agent-btn is-allow"
              onClick={() => void bridge.resolveApproval(approval.id, "allow")}
            >
              Allow
            </button>
          </div>
        </div>
      )}

      <footer className="set-foot agent-composer">
        {notice !== null && <p className="agent-notice">{notice}</p>}

        {/*
          One line about where this run would go, and one way to change it. Key
          entry itself lives in the command center: two places to type a
          credential is one more than a user should have to trust.
        */}
        {provider !== "unavailable" && (
          <div className="agent-config-row">
            <span className="agent-notice">
              {provider === "connected"
                ? routeSummary(companion, config)
                : "No provider connected, so runs stop after reading context."}
            </span>
            <button
              type="button"
              className="text-btn"
              onClick={() => setCommandCenterOpen(true)}
            >
              {provider === "connected" ? "Manage" : "Connect"}
            </button>
          </div>
        )}

        <div className="agent-context" role="group" aria-label="Tabs shared with this run">
          {browser.tabs.map((tab) => {
            const shared = contextTabIds.includes(tab.id);
            return (
              <button
                key={tab.id}
                type="button"
                className={`agent-chip${shared ? " is-on" : ""}`}
                aria-pressed={shared}
                aria-label={`${shared ? "Stop sharing" : "Share"} ${tabAccessibleName(tab)}`}
                onClick={() =>
                  setContextTabIds((current) => toggleContextTab(current, tab.id, browser))
                }
              >
                {displayHostname(tab.url)}
              </button>
            );
          })}
        </div>

        <form className="agent-form" onSubmit={submit}>
          <textarea
            className="agent-input"
            value={task}
            rows={2}
            placeholder="Ask your companion to do something"
            spellCheck={false}
            aria-label="Task"
            onChange={(event) => setTask(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention for a
              // composer, and it keeps the submit button from being the only way.
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              submit(event);
            }}
          />
          {isRunAdvancing(status) && run !== null ? (
            <button
              type="button"
              className="agent-send"
              onClick={() => void bridge.cancelRun(run.id)}
              aria-label="Stop this run"
            >
              <Square size={13} strokeWidth={1.5} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className="agent-send"
              disabled={!submittable}
              aria-label="Start the run"
            >
              <ArrowUp size={15} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </form>
      </footer>
    </aside>
  );
}
