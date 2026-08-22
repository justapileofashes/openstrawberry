import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, SlidersHorizontal, Trash2, X } from "lucide-react";
import {
  activeCompanion,
  MAX_AGENTS,
  MAX_AGENT_NAME_LENGTH,
  MAX_CONTEXT_WINDOW,
  MAX_PROVIDER_LABEL_LENGTH,
  MAX_TEMPERATURE,
  MIN_CONTEXT_WINDOW,
  providerDescriptor,
  PROVIDERS,
  resolvedProvider,
  type AgentCompanion,
  type AgentConfigStatus,
  type AgentSnapshot,
  type ProviderId,
  type ProviderStatus
} from "../shared/agents.js";
import { canSaveCredential, encryptionNotice } from "./agent-chrome.js";
import { useFocusTrap } from "./focus-trap.js";
import {
  agentKeySource,
  agentKeySummary,
  agentReadiness,
  agentTestRequest,
  type AgentReadiness,
  canCreateAgent,
  canDeleteAgent,
  canSaveAgent,
  canSaveOrchestrator,
  canTestAgent,
  contextWindowPlaceholder,
  draftCommandPlaceholder,
  draftFrom,
  draftModelPlaceholder,
  draftRole,
  draftRouteSummary,
  emptyDraft,
  isValidBaseUrl,
  isValidCommand,
  isValidContextWindow,
  isValidModel,
  isValidTemperature,
  orchestratorDraftFrom,
  orchestratorIsCli,
  orchestratorNeedsBaseUrl,
  orchestratorRouteSummary,
  providerStatusFor,
  providerSummary,
  routeSummary,
  testSummary,
  toCompanionDraft,
  toModelTuning,
  tuningDraftFor,
  type AgentDraft,
  type OrchestratorDraft,
  type TestState,
  type TuningDraft
} from "./command-center.js";

/** What the editor is currently for: a new agent, an existing one, or nothing. */
type Editing = { readonly mode: "create" } | { readonly mode: "edit"; readonly id: string };

/**
 * Which route the configuration dialog is open over, if any.
 *
 * The agent case carries the id rather than reading it back off `editing`,
 * because it is also the key scope: a dialog opened for an agent that does not
 * exist yet has nowhere to store an agent-scoped key, and null says so.
 */
type DialogTarget =
  | { readonly kind: "orchestrator" }
  | { readonly kind: "agent"; readonly companionId: string | null };

const READINESS_LABEL: Record<AgentReadiness, string> = {
  ready: "Ready",
  "needs-key": "Needs a key",
  "no-encryption": "Cannot store a key"
};

/*
 * A wrapping `<label>` names the control it contains, but a `<select>` inside
 * one has its options counted as part of that name and ends up called after its
 * own value. Every control here therefore carries an explicit `aria-label` as
 * well — and one that says which of the two provider pairs on screen it belongs
 * to, since "Provider" alone would name both.
 *
 * `required` draws the asterisk and sets `aria-required` on the field, so the
 * mark is not the sighted user's alone. It is deliberately a prop rather than a
 * guess from the label: which fields a provider insists on changes with the
 * provider, and a form that marks the wrong ones is worse than one that marks
 * none.
 */
function Field({
  label,
  hint,
  required = false,
  children
}: {
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="cc-field" aria-required={required || undefined}>
      <span className="cc-field-label">
        {label}
        {required && (
          <span className="cc-required" aria-hidden="true">
            *
          </span>
        )}
      </span>
      {children}
      {hint !== undefined && <span className="cc-field-hint">{hint}</span>}
    </label>
  );
}


/**
 * One route, as the configuration dialog holds it.
 *
 * The same four fields both callers already had, plus the model settings. The
 * orchestrator and an agent differ only in whether `provider` may be null, so
 * one shape serves both and the dialog never has to know which it is editing.
 */
export interface RouteDraft {
  readonly provider: ProviderId | null;
  readonly model: string;
  readonly baseUrl: string;
  readonly command: string;
  readonly tuning: TuningDraft;
}

/**
 * What the dialog is configuring, in the words its header uses.
 *
 * `keyScope` is the one thing that genuinely differs between the two callers: an
 * agent being edited can hold a key of its own, while the orchestrator — and an
 * agent that does not exist yet — can only reach the shared one. Passing the
 * scope rather than a flag keeps the dialog from having to infer it.
 */
export interface DialogSubject {
  readonly title: string;
  readonly description: string;
  /** The agent whose own key this dialog writes, or null for the shared key. */
  readonly keyScope: string | null;
  /** Shown under the key field, so the user knows whose key they are typing. */
  readonly keyScopeLabel: string;
  /** Offered as a provider choice only where following is a real option. */
  readonly inheritLabel: string | null;
  /**
   * An extra condition on Apply, beyond the route being valid.
   *
   * The orchestrator uses it to refuse a form that matches what is already
   * saved: repointing it moves every agent that follows it, and a button that
   * stays live after the change has landed invites the user to wonder whether
   * it did. An agent's editor has its own Save and imposes nothing here.
   */
  readonly canApply?: (draft: RouteDraft) => boolean;
}

/**
 * The provider configuration dialog.
 *
 * A dialog rather than a run of fields in the panel, because configuring a route
 * is a decision with an end: you pick a provider, say where it is and what it
 * costs, try it, and either keep it or throw it away. Cancel has to mean
 * something for that to be true, which is why the draft lives here and the
 * caller hears about an Apply and nothing else.
 *
 * The three buttons run in order of increasing commitment, and Test sits between
 * the other two on purpose: it is the only one that can tell you whether Apply
 * is a good idea.
 */
function ProviderDialog({
  subject,
  initial,
  config,
  onApply,
  onClose
}: {
  readonly subject: DialogSubject;
  readonly initial: RouteDraft;
  readonly config: AgentConfigStatus;
  /** The finished route, plus a key to store for it if one was typed. */
  readonly onApply: (draft: RouteDraft, key: string | null) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  const bridge = window.openstrawberry.agents;
  const [draft, setDraft] = useState<RouteDraft>(initial);
  const [keyDraft, setKeyDraft] = useState("");
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  const descriptor = draft.provider === null ? null : providerDescriptor(draft.provider);
  const needsBaseUrl = descriptor?.requiresBaseUrl === true;
  const isCli = descriptor?.transport === "cli";
  const notice = encryptionNotice(config);

  /*
   * Every edit invalidates the last result. A dialog still showing a pass from
   * before the endpoint was changed would be reporting on a configuration that
   * no longer exists anywhere on screen.
   */
  const edit = useCallback((next: RouteDraft) => {
    setDraft(next);
    setTest({ kind: "idle" });
  }, []);

  /*
   * The route as the shared validators want it. Name and role are placeholders
   * with no field on this dialog: it configures where a route points, and an
   * agent's name is edited beside the roster where it is read.
   */
  const routeDraft: AgentDraft = {
    name: "route",
    role: "route",
    provider: draft.provider,
    model: draft.model,
    baseUrl: draft.baseUrl,
    command: draft.command,
    tuning: draft.tuning
  };

  const testable = canTestAgent(routeDraft) && config.encryption === "available";
  const appliable =
    canSaveAgent(routeDraft) && (subject.canApply?.(draft) ?? true);
  // The program that was actually checked: what the user typed, or the preset's
  // own when the box was left blank — which is what the check falls back to.
  const summary = testSummary(test, {
    isCli,
    command: draft.command.trim() || draftCommandPlaceholder(routeDraft)
  });

  const runTest = useCallback(() => {
    const request = agentTestRequest(routeDraft, subject.keyScope);
    if (request === null) return;

    setTest({ kind: "running" });
    void bridge
      .testProvider(request)
      .then((result) =>
        setTest(
          result.ok
            ? { kind: "passed", elapsedMs: result.elapsedMs }
            : { kind: "failed", code: result.code }
        )
      )
      /*
       * The bridge is documented never to reject, so this is a broken channel
       * rather than a provider that said no — reported as the network failure it
       * is, instead of being swallowed into a silent idle.
       */
      .catch(() => setTest({ kind: "failed", code: "network" }));
  }, [bridge, routeDraft, subject.keyScope]);

  return (
    <div className="cc-dialog-scrim">
      <section
        className="cc-dialog glass"
        role="dialog"
        aria-modal="true"
        ref={trapRef}
        aria-label={subject.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="cc-dialog-head">
          <div>
            <h2 className="cc-dialog-title">{subject.title}</h2>
            <p className="cc-dialog-lede">{subject.description}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close provider configuration"
          >
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </header>

        <div className="cc-dialog-body">
          <div className="cc-pair">
            <Field label="Provider Type" required>
              <select
                className="cc-select"
                value={draft.provider ?? ""}
                aria-label="Provider type"
                onChange={(event) => {
                  const next =
                    event.target.value === "" ? null : (event.target.value as ProviderId);
                  /*
                   * A model, an endpoint, a program, and a context window all
                   * belong to the provider they were chosen for. Carrying any of
                   * them into a different provider would leave a setting that
                   * looks deliberate and is not.
                   */
                  edit({
                    provider: next,
                    model:
                      PROVIDERS.find((entry) => entry.id === next)?.defaultModel ?? "",
                    baseUrl: "",
                    command: "",
                    tuning: tuningDraftFor(next)
                  });
                }}
              >
                {subject.inheritLabel !== null && (
                  <option value="">{subject.inheritLabel}</option>
                )}
                {PROVIDERS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Provider Name">
              <input
                type="text"
                className="cc-input"
                value={draft.tuning.providerLabel}
                maxLength={MAX_PROVIDER_LABEL_LENGTH}
                placeholder={descriptor?.label ?? "Follows the orchestrator"}
                spellCheck={false}
                autoComplete="off"
                aria-label="Provider name"
                disabled={descriptor === null}
                onChange={(event) =>
                  edit({
                    ...draft,
                    tuning: { ...draft.tuning, providerLabel: event.target.value }
                  })
                }
              />
            </Field>
          </div>

          {descriptor !== null && (
            <p className="cc-hint cc-provider-summary">{descriptor.summary}</p>
          )}

          {/*
            Only for the provider that asks for one. This field decides where an
            API key is sent, so it appears exactly where that is true and nowhere
            else — a base URL box beside a preset would look like it redirected
            the request and would not.
          */}
          {needsBaseUrl && (
            <Field
              label="Base URL"
              required
              hint="HTTPS only. This is where the key below is sent."
            >
              <input
                type="url"
                className="cc-input"
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                autoComplete="off"
                aria-label="Base URL"
                aria-invalid={
                  draft.baseUrl.trim().length > 0 && !isValidBaseUrl(draft.baseUrl)
                }
                onChange={(event) => edit({ ...draft, baseUrl: event.target.value })}
              />
            </Field>
          )}

          {needsBaseUrl &&
            draft.baseUrl.trim().length > 0 &&
            !isValidBaseUrl(draft.baseUrl) && (
              <p className="agent-notice is-bad">
                Must be an https:// URL with no query, fragment, or embedded password.
              </p>
            )}

          {/*
            The key, where the provider takes one. It is typed here and stored on
            Apply, so cancelling a half-configured route leaves no credential
            behind for a provider the user decided against.
          */}
          {descriptor?.requiresCredential === true && (
            <Field
              label="API Key"
              required
              hint={
                config.encryption === "available"
                  ? `Encrypted by your operating system and stored locally. ${subject.keyScopeLabel}`
                  : "This system cannot encrypt a key, so none will be stored."
              }
            >
              <input
                type="password"
                className="cc-input"
                value={keyDraft}
                placeholder={
                  providerStatusFor(config, descriptor.id)?.configured === true
                    ? "A key is stored — type to replace it"
                    : "Enter your API key"
                }
                autoComplete="off"
                spellCheck={false}
                aria-label="API key"
                disabled={config.encryption !== "available"}
                onChange={(event) => setKeyDraft(event.target.value)}
              />
            </Field>
          )}

          {notice !== null && <p className="agent-notice">{notice}</p>}

          {/*
            A CLI provider runs a program on this machine. The field says so in
            as many words: this is the one setting here whose effect is a process
            starting rather than a request being sent.
          */}
          {isCli && (
            <Field
              label="Command"
              hint={`OpenStrawberry runs this program on your machine. Leave blank to use ${draftCommandPlaceholder(
                routeDraft
              )} from your PATH.`}
            >
              <input
                type="text"
                className="cc-input"
                value={draft.command}
                placeholder={draftCommandPlaceholder(routeDraft)}
                spellCheck={false}
                autoComplete="off"
                aria-label="Command"
                aria-invalid={
                  draft.command.trim().length > 0 && !isValidCommand(draft.command)
                }
                onChange={(event) => edit({ ...draft, command: event.target.value })}
              />
            </Field>
          )}

          {isCli && draft.command.trim().length > 0 && !isValidCommand(draft.command) && (
            <p className="agent-notice is-bad">
              Must be a program name or path — no arguments, and no shell characters.
            </p>
          )}

          <Field
            label="Model"
            required={descriptor?.requiresModel === true}
            {...(isCli
              ? { hint: "Optional. Leave blank and the CLI picks its own." }
              : {})}
          >
            <input
              type="text"
              className="cc-input"
              value={draft.model}
              placeholder={draftModelPlaceholder(routeDraft, config)}
              spellCheck={false}
              autoComplete="off"
              aria-label="Model"
              aria-invalid={draft.model.trim().length > 0 && !isValidModel(draft.model)}
              onChange={(event) => edit({ ...draft, model: event.target.value })}
            />
          </Field>

          {/*
            Below the rule is what the model is, rather than where it is. The
            split is the point: everything above decides which machine answers,
            and nothing below can change that.
          */}
          <hr className="cc-dialog-rule" />
          <h3 className="cc-dialog-section">Model Configuration</h3>

          <label className="cc-check">
            <input
              type="checkbox"
              checked={draft.tuning.supportsImages ?? false}
              disabled={descriptor === null || isCli}
              aria-label="Supports images"
              onChange={(event) =>
                edit({
                  ...draft,
                  tuning: { ...draft.tuning, supportsImages: event.target.checked }
                })
              }
            />
            <span>Supports Images</span>
          </label>
          {/*
            The fields below stay on screen for a route that cannot use them, and
            are dimmed instead. An absent field reads as a feature this app is
            missing; a dimmed one reads as a setting this route does not have —
            which is the true statement, and the one worth making.
          */}
          <p className="cc-field-hint cc-check-hint">
            {isCli
              ? "A CLI holds its own session and manages its own context, so none of these are OpenStrawberry's to set."
              : "Declares what this model accepts. Nothing in OpenStrawberry sends an image to a provider yet, so today this records the answer rather than acting on it."}
          </p>

          <div className="cc-pair">
            <Field
              label="Context Window Size"
              hint={
                descriptor === null || descriptor.defaultContextWindow === null
                  ? "In tokens. Blank leaves the shipped limit in place."
                  : "Auto-filled from the provider. In tokens."
              }
            >
              <input
                type="text"
                inputMode="numeric"
                className="cc-input"
                value={draft.tuning.contextWindow}
                placeholder={contextWindowPlaceholder(draft.provider)}
                spellCheck={false}
                autoComplete="off"
                aria-label="Context window size"
                disabled={descriptor === null || isCli}
                aria-invalid={!isValidContextWindow(draft.tuning.contextWindow)}
                onChange={(event) =>
                  edit({
                    ...draft,
                    tuning: { ...draft.tuning, contextWindow: event.target.value }
                  })
                }
              />
            </Field>

            <Field
              label={`Temperature (0–${MAX_TEMPERATURE})`}
              hint="Controls response randomness. Blank sends none at all."
            >
              <input
                type="text"
                inputMode="decimal"
                className="cc-input"
                value={draft.tuning.temperature}
                placeholder="Provider default"
                spellCheck={false}
                autoComplete="off"
                aria-label="Temperature"
                disabled={descriptor === null || isCli}
                aria-invalid={!isValidTemperature(draft.tuning.temperature)}
                onChange={(event) =>
                  edit({
                    ...draft,
                    tuning: { ...draft.tuning, temperature: event.target.value }
                  })
                }
              />
            </Field>
          </div>

          {!isValidContextWindow(draft.tuning.contextWindow) && (
            <p className="agent-notice is-bad">
              {`The context window must be a whole number between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW} tokens.`}
            </p>
          )}

          {!isValidTemperature(draft.tuning.temperature) && (
            <p className="agent-notice is-bad">
              {`The temperature must be a number between 0 and ${MAX_TEMPERATURE}.`}
            </p>
          )}
        </div>

        <footer className="cc-dialog-foot">
          {summary !== null && (
            <p
              className={`cc-test-result is-${test.kind}`}
              role={test.kind === "failed" ? "alert" : "status"}
            >
              {summary}
            </p>
          )}

          <div className="cc-dialog-actions">
            <button type="button" className="text-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="agent-btn is-quiet"
              disabled={!testable || test.kind === "running"}
              title={
                config.encryption === "available"
                  ? undefined
                  : "A test would need a stored key, and this system cannot store one."
              }
              onClick={runTest}
            >
              {test.kind === "running" ? "Testing…" : "Test"}
            </button>
            <button
              type="button"
              className="agent-btn"
              disabled={!appliable}
              onClick={() => {
                // Handed over and dropped in the same tick, exactly as the
                // provider list does it. Nothing reads it back.
                const key = keyDraft.trim();
                setKeyDraft("");
                onApply(draft, key.length === 0 ? null : key);
              }}
            >
              Apply
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

/**
 * A one-line statement of where a route points, for the panel behind the dialog.
 *
 * The panel no longer holds the fields, so it has to say what they add up to —
 * otherwise opening the dialog would be the only way to find out what the
 * orchestrator is running on.
 */
function RouteRow({
  label,
  summary,
  actionLabel,
  onConfigure
}: {
  readonly label: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly onConfigure: () => void;
}): React.JSX.Element {
  return (
    <div className="cc-route">
      <div className="cc-route-text">
        <span className="cc-route-label">{label}</span>
        <span className="cc-route-summary">{summary}</span>
      </div>
      <button type="button" className="agent-btn is-quiet" onClick={onConfigure}>
        <SlidersHorizontal size={13} strokeWidth={1.5} aria-hidden="true" />
        {actionLabel}
      </button>
    </div>
  );
}

/**
 * Where this surface is being drawn.
 *
 * `sheet` is the companion panel's own settings surface, opened over the
 * transcript and closed again. `page` is a new tab: the same three sections, but
 * they are what the tab *is* rather than something covering it, so there is
 * nothing to dismiss and no close control to offer.
 */
export type CommandCenterVariant = "sheet" | "page";

/**
 * The agent command center.
 *
 * As a sheet it sits over the companion panel rather than beside it, because the
 * panel is already a grid column the pane gave up its width for — taking more
 * would move the page out from under the user to show them a settings sheet.
 *
 * Three things live here, in the order a user meets them: what the orchestrator
 * runs on, the roster of agents and what each one is pinned to, and the keys
 * those providers need. Keys come last on purpose — it is the only section that
 * can be refused outright, and leading with a refusal would suggest the rest of
 * the surface is unusable too.
 */
export function CommandCenter({
  snapshot,
  variant = "sheet",
  onClose
}: {
  readonly snapshot: AgentSnapshot;
  readonly variant?: CommandCenterVariant;
  readonly onClose?: () => void;
}): React.JSX.Element {
  const bridge = window.openstrawberry.agents;
  const config = snapshot.config;

  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [orchestrator, setOrchestrator] = useState<OrchestratorDraft>(() =>
    orchestratorDraftFrom(config)
  );
  const [connecting, setConnecting] = useState<ProviderId | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const [agentKeyOpen, setAgentKeyOpen] = useState(false);
  const [agentKeyDraft, setAgentKeyDraft] = useState("");
  const [dialog, setDialog] = useState<DialogTarget | null>(null);

  // The orchestrator can move from elsewhere — another window, a restore — so
  // the form follows the saved value rather than drifting from it.
  useEffect(() => {
    setOrchestrator(orchestratorDraftFrom(config));
  }, [config.provider, config.model, config.baseUrl, config.command, config.tuning]);

  const selected = activeCompanion(snapshot);
  const notice = encryptionNotice(config);

  const openEditor = useCallback((companion: AgentCompanion) => {
    setEditing({ mode: "edit", id: companion.id });
    setDraft(draftFrom(companion));
    // A half-typed key does not follow the user to another agent.
    setAgentKeyOpen(false);
    setAgentKeyDraft("");
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(null);
    setDraft(emptyDraft());
    setAgentKeyOpen(false);
    setAgentKeyDraft("");
  }, []);

  const submitAgent = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (editing === null || !canSaveAgent(draft)) return;

      const payload = toCompanionDraft(draft);
      void (editing.mode === "create"
        ? bridge.createCompanion(payload)
        : bridge.updateCompanion(editing.id, payload));

      closeEditor();
    },
    [bridge, editing, draft, closeEditor]
  );

  const saveKey = useCallback(
    (event: React.FormEvent, provider: ProviderId) => {
      event.preventDefault();
      if (!canSaveCredential(keyDraft, config)) return;

      // Handed over and dropped from component state in the same tick. Nothing
      // reads it back — the reply is status, not the value.
      const key = keyDraft.trim();
      setKeyDraft("");
      setSaveFailed(false);

      void bridge
        .setCredential(provider, key)
        .then(() => setConnecting(null))
        .catch(() => setSaveFailed(true));
    },
    [bridge, keyDraft, config]
  );

  /**
   * Takes a finished route out of the dialog and puts it where it belongs.
   *
   * The key is stored first and deliberately: an agent pinned to a provider it
   * has no key for is a route that reports itself broken, and doing it in this
   * order means the roster never shows that state for a configuration the user
   * actually completed.
   */
  const applyDialog = useCallback(
    (target: DialogTarget, route: RouteDraft, key: string | null) => {
      if (key !== null && route.provider !== null && canSaveCredential(key, config)) {
        void bridge.setCredential(
          route.provider,
          key,
          target.kind === "agent" ? target.companionId : null
        );
      }

      if (target.kind === "orchestrator") {
        // The dialog offers no "follow" option here, so a null provider would be
        // a bug rather than a choice — the saved one stands.
        const provider = route.provider ?? orchestrator.provider;
        const next: OrchestratorDraft = { ...route, provider };

        setOrchestrator(next);
        void bridge.setOrchestrator(
          provider,
          route.model.trim(),
          orchestratorNeedsBaseUrl(next) ? route.baseUrl.trim() : null,
          orchestratorIsCli(next) && route.command.trim().length > 0
            ? route.command.trim()
            : null,
          toModelTuning(provider, route.tuning)
        );
      } else {
        // The agent's own form keeps the name and role; only the route moves.
        setDraft((current) => ({ ...current, ...route }));
      }

      setDialog(null);
    },
    [bridge, config, orchestrator.provider]
  );

  /** The dialog's header, key scope, and starting draft for whichever route it is over. */
  const dialogProps = useMemo(() => {
    if (dialog === null) return null;

    if (dialog.kind === "orchestrator") {
      return {
        subject: {
          title: "Configure Orchestrator Provider",
          description:
            "Where the orchestrator runs, and what every agent that follows it inherits.",
          keyScope: null,
          keyScopeLabel: "Saved as the shared key for this provider.",
          inheritLabel: null,
          canApply: (route) =>
            route.provider !== null &&
            canSaveOrchestrator({ ...route, provider: route.provider }, config)
        } satisfies DialogSubject,
        initial: {
          provider: orchestrator.provider,
          model: orchestrator.model,
          baseUrl: orchestrator.baseUrl,
          command: orchestrator.command,
          tuning: orchestrator.tuning
        } satisfies RouteDraft
      };
    }

    const named =
      dialog.companionId === null
        ? null
        : snapshot.companions.find((entry) => entry.id === dialog.companionId) ?? null;

    return {
      subject: {
        title: named === null ? "Configure New Provider" : "Configure Provider",
        description:
          "Add a new LLM provider configuration with API key and model settings.",
        keyScope: dialog.companionId,
        keyScopeLabel:
          named === null
            ? "Saved as the shared key for this provider, since this agent does not exist yet."
            : `Saved as ${named.name}'s own key, which overrides the shared one.`,
        inheritLabel: "Follow the orchestrator"
      } satisfies DialogSubject,
      initial: {
        provider: draft.provider,
        model: draft.model,
        baseUrl: draft.baseUrl,
        command: draft.command,
        tuning: draft.tuning
      } satisfies RouteDraft
    };
  }, [dialog, orchestrator, draft, snapshot.companions]);

  const isPage = variant === "page";

  // Deliberately not `.glass`: as a sheet this covers the transcript rather than
  // sitting beside it, and a backdrop blur would turn the log underneath into
  // texture instead of hiding it.
  return (
    <section
      className={`cc${isPage ? " is-page" : ""}`}
      /*
       * A dialog only when it behaves like one. As a new tab this is the tab's
       * own content, and announcing it as a dialog would tell a screen-reader
       * user there is something to dismiss to get back to the page — when this
       * is the page.
       */
      role={isPage ? "region" : "dialog"}
      aria-label="Agent command center"
    >
      <header className="set-head">
        <div>
          <span className="eyebrow">Command center</span>
          <h2>Agents</h2>
        </div>
        {onClose !== undefined && (
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close command center"
          >
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="set-body cc-body">
        <section className="cc-section" aria-labelledby="cc-orchestrator">
          <h3 className="cc-title" id="cc-orchestrator">
            Orchestrator
          </h3>
          <p className="cc-hint">
            Plans the work and hands it out. Every agent that has not been pinned to a
            provider of its own runs on this one.
          </p>

          <RouteRow
            label="Runs on"
            summary={orchestratorRouteSummary(config)}
            actionLabel="Configure provider"
            onConfigure={() => {
              setOrchestrator(orchestratorDraftFrom(config));
              setDialog({ kind: "orchestrator" });
            }}
          />
        </section>

        <section className="cc-section" aria-labelledby="cc-roster">
          <h3 className="cc-title" id="cc-roster">
            Roster
            <span className="cc-count">
              {snapshot.companions.length} of {MAX_AGENTS}
            </span>
          </h3>
          <p className="cc-hint">
            The agent you pick here is the one the composer talks to.
          </p>

          <ul className="cc-roster">
            {snapshot.companions.map((companion) => {
              const readiness = agentReadiness(companion, config);
              const isSelected = selected?.id === companion.id;
              const isEditing = editing?.mode === "edit" && editing.id === companion.id;

              return (
                <li key={companion.id} className="cc-agent-row">
                  <button
                    type="button"
                    className={`cc-agent${isSelected ? " is-selected" : ""}${
                      isEditing ? " is-editing" : ""
                    }`}
                    aria-current={isSelected}
                    aria-label={`${companion.name}, ${companion.role}, ${routeSummary(
                      companion,
                      config
                    )}, ${READINESS_LABEL[readiness]}`}
                    onClick={() => {
                      void bridge.selectCompanion(companion.id);
                      openEditor(companion);
                    }}
                  >
                    <span className="cc-agent-name">{companion.name}</span>
                    <span className="cc-agent-role">{companion.role}</span>
                    <span className="cc-agent-route">{routeSummary(companion, config)}</span>
                    <span className="cc-agent-state" data-readiness={readiness}>
                      {READINESS_LABEL[readiness]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {editing === null ? (
            <button
              type="button"
              className="agent-btn cc-new"
              disabled={!canCreateAgent(snapshot.companions)}
              onClick={() => {
                setEditing({ mode: "create" });
                setDraft(emptyDraft());
              }}
            >
              <Plus size={13} strokeWidth={1.5} aria-hidden="true" />
              New agent
            </button>
          ) : (
            <form className="cc-form cc-editor" onSubmit={submitAgent}>
              <span className="eyebrow">
                {editing.mode === "create" ? "New agent" : "Edit agent"}
              </span>

              <Field label="Name">
                <input
                  type="text"
                  className="cc-input"
                  value={draft.name}
                  maxLength={MAX_AGENT_NAME_LENGTH}
                  placeholder="Scout"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Agent name"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>

              <Field
                label="Role"
                hint={`Saved as ${draftRole(draft)}. Ranks which skills get suggested.`}
              >
                <input
                  type="text"
                  className="cc-input"
                  value={draft.role}
                  placeholder="research"
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Agent role"
                  onChange={(event) => setDraft({ ...draft, role: event.target.value })}
                />
              </Field>

              {/*
                The route, and a way in to change it. The fields themselves live
                in the dialog: an agent's name and role are read from the roster
                and belong beside it, while where it points is a decision with a
                Cancel — and those two do not want the same surface.
              */}
              <RouteRow
                label="Provider"
                summary={draftRouteSummary(draft, config)}
                actionLabel="Configure provider"
                onConfigure={() =>
                  setDialog({
                    kind: "agent",
                    companionId: editing.mode === "edit" ? editing.id : null
                  })
                }
              />

              {editing.mode === "edit" ? (
                <AgentKeyRow
                  companion={
                    snapshot.companions.find((entry) => entry.id === editing.id) ?? null
                  }
                  config={config}
                  isEntering={agentKeyOpen}
                  keyDraft={agentKeyDraft}
                  onOpen={() => {
                    setAgentKeyOpen(true);
                    setAgentKeyDraft("");
                  }}
                  onCancel={() => {
                    setAgentKeyOpen(false);
                    setAgentKeyDraft("");
                  }}
                  onKeyDraft={setAgentKeyDraft}
                  onSave={(provider) => {
                    const key = agentKeyDraft.trim();
                    setAgentKeyDraft("");
                    setAgentKeyOpen(false);
                    void bridge.setCredential(provider, key, editing.id);
                  }}
                  onClear={(provider) =>
                    void bridge.clearCredential(provider, editing.id)
                  }
                />
              ) : (
                <p className="cc-hint">
                  This agent can hold a key of its own once it exists. Create it first,
                  then reopen it here.
                </p>
              )}

              <div className="cc-actions">
                {editing.mode === "edit" && (
                  <button
                    type="button"
                    className="agent-btn is-deny cc-delete"
                    disabled={!canDeleteAgent(snapshot.companions)}
                    title={
                      canDeleteAgent(snapshot.companions)
                        ? undefined
                        : "The last agent cannot be removed."
                    }
                    onClick={() => {
                      void bridge.deleteCompanion(editing.id);
                      closeEditor();
                    }}
                  >
                    <Trash2 size={13} strokeWidth={1.5} aria-hidden="true" />
                    Delete
                  </button>
                )}
                <button type="button" className="text-btn" onClick={closeEditor}>
                  Cancel
                </button>
                <button type="submit" className="agent-btn" disabled={!canSaveAgent(draft)}>
                  {editing.mode === "create" ? "Create" : "Save"}
                </button>
              </div>
            </form>
          )}
        </section>

        <section className="cc-section" aria-labelledby="cc-providers">
          <h3 className="cc-title" id="cc-providers">
            Providers
          </h3>
          <p className="cc-hint">
            The shared key for each provider — what an agent uses unless it has been
            given one of its own. Keys are encrypted by the operating system and never
            read back out; what comes back here is whether one is stored.
          </p>

          {notice !== null && <p className="agent-notice">{notice}</p>}

          <ul className="cc-providers">
            {config.providers.map((provider) => (
              <li key={provider.id} className="cc-provider">
                <div className="cc-provider-head">
                  <span className="cc-provider-name">{provider.label}</span>
                  <span className="cc-provider-state" data-configured={provider.configured}>
                    {providerSummary(provider)}
                  </span>
                  <ProviderAction
                    provider={provider}
                    canConnect={config.encryption === "available"}
                    isConnecting={connecting === provider.id}
                    onConnect={() => {
                      setConnecting(provider.id);
                      setKeyDraft("");
                      setSaveFailed(false);
                    }}
                    onDisconnect={() => void bridge.clearCredential(provider.id, null)}
                  />
                </div>

                <p className="cc-hint cc-provider-summary">{provider.summary}</p>

                {connecting === provider.id && (
                  <form className="agent-key" onSubmit={(event) => saveKey(event, provider.id)}>
                    <input
                      type="password"
                      className="agent-input agent-key-input"
                      value={keyDraft}
                      placeholder={`${provider.label} API key`}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`${provider.label} API key`}
                      onChange={(event) => setKeyDraft(event.target.value)}
                    />
                    <button
                      type="submit"
                      className="agent-btn"
                      disabled={!canSaveCredential(keyDraft, config)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        setKeyDraft("");
                        setConnecting(null);
                        setSaveFailed(false);
                      }}
                    >
                      Cancel
                    </button>
                    {saveFailed && (
                      <p className="agent-notice is-bad" role="alert">
                        The key could not be stored. It was not saved.
                      </p>
                    )}
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/*
        Keyed on the target so switching from the orchestrator to an agent, or
        between two agents, mounts a fresh dialog rather than leaving one holding
        the previous route's draft.
      */}
      {dialog !== null && dialogProps !== null && (
        <ProviderDialog
          key={dialog.kind === "orchestrator" ? "orchestrator" : dialog.companionId ?? "new"}
          subject={dialogProps.subject}
          initial={dialogProps.initial}
          config={config}
          onApply={(route, key) => applyDialog(dialog, route, key)}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

/**
 * The key this one agent authenticates with.
 *
 * Its own key overrides the shared one; without it the agent falls back. The row
 * always says which of those is in force, because "this agent has a key" and
 * "some key exists" are the kind of distinction a user only discovers is
 * important after a request went out under the wrong account.
 */
function AgentKeyRow({
  companion,
  config,
  isEntering,
  keyDraft,
  onOpen,
  onCancel,
  onKeyDraft,
  onSave,
  onClear
}: {
  readonly companion: AgentCompanion | null;
  readonly config: AgentConfigStatus;
  readonly isEntering: boolean;
  readonly keyDraft: string;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onKeyDraft: (next: string) => void;
  readonly onSave: (provider: ProviderId) => void;
  readonly onClear: (provider: ProviderId) => void;
}): React.JSX.Element | null {
  if (companion === null) return null;

  const route = resolvedProvider(companion, config);
  const provider = providerDescriptor(route.provider);
  if (provider === null || !provider.requiresCredential) {
    return <p className="cc-hint">{agentKeySummary(companion, config)}</p>;
  }

  const source = agentKeySource(companion, config);

  return (
    <div className="cc-agent-key">
      <div className="agent-config-row">
        <span className="cc-hint">{agentKeySummary(companion, config)}</span>
        {source === "own" ? (
          <button
            type="button"
            className="text-btn"
            onClick={() => onClear(provider.id)}
          >
            Remove its key
          </button>
        ) : (
          !isEntering && (
            <button
              type="button"
              className="text-btn"
              disabled={config.encryption !== "available"}
              onClick={onOpen}
            >
              Give it its own key
            </button>
          )
        )}
      </div>

      {isEntering && (
        <div className="agent-key">
          <input
            type="password"
            className="agent-input agent-key-input"
            value={keyDraft}
            placeholder={`${provider.label} API key for ${companion.name}`}
            autoComplete="off"
            spellCheck={false}
            aria-label={`${provider.label} API key for this agent`}
            onChange={(event) => onKeyDraft(event.target.value)}
          />
          <button
            type="button"
            className="agent-btn"
            disabled={!canSaveCredential(keyDraft, config)}
            onClick={() => onSave(provider.id)}
          >
            Save
          </button>
          <button type="button" className="text-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** Connect, disconnect, or nothing at all for a provider that needs no key. */
function ProviderAction({
  provider,
  canConnect,
  isConnecting,
  onConnect,
  onDisconnect
}: {
  readonly provider: ProviderStatus;
  readonly canConnect: boolean;
  readonly isConnecting: boolean;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}): React.JSX.Element | null {
  if (!provider.requiresCredential) return null;

  if (provider.configured) {
    return (
      <button type="button" className="text-btn" onClick={onDisconnect}>
        Disconnect
      </button>
    );
  }

  if (isConnecting) return null;

  return (
    <button type="button" className="text-btn" disabled={!canConnect} onClick={onConnect}>
      {`Connect ${provider.label}`}
    </button>
  );
}
