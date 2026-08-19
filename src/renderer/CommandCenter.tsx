import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  activeCompanion,
  defaultCommandFor,
  defaultModelFor,
  MAX_AGENTS,
  MAX_AGENT_NAME_LENGTH,
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
import {
  agentKeySource,
  agentKeySummary,
  agentReadiness,
  type AgentReadiness,
  canCreateAgent,
  canDeleteAgent,
  canSaveAgent,
  canSaveOrchestrator,
  draftCommandPlaceholder,
  draftFrom,
  draftIsCli,
  draftModelPlaceholder,
  draftNeedsBaseUrl,
  draftRole,
  emptyDraft,
  isValidBaseUrl,
  isValidCommand,
  orchestratorDraftFrom,
  orchestratorIsCli,
  orchestratorNeedsBaseUrl,
  providerSummary,
  routeSummary,
  toCompanionDraft,
  type AgentDraft,
  type OrchestratorDraft
} from "./command-center.js";

/** What the editor is currently for: a new agent, an existing one, or nothing. */
type Editing = { readonly mode: "create" } | { readonly mode: "edit"; readonly id: string };

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
 */
function Field({
  label,
  hint,
  children
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="cc-field">
      <span className="cc-field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="cc-field-hint">{hint}</span>}
    </label>
  );
}

/**
 * Provider and model, the pair every routing decision in the app is made of.
 *
 * `inheritLabel` is what makes this reusable across the orchestrator and an
 * agent: the orchestrator must name a provider, while an agent may decline to
 * and follow it instead.
 */
function ProviderFields({
  scope,
  provider,
  model,
  modelPlaceholder,
  inheritLabel,
  baseUrl,
  needsBaseUrl,
  command,
  commandPlaceholder,
  isCli,
  onProvider,
  onModel,
  onBaseUrl,
  onCommand
}: {
  readonly scope: string;
  readonly provider: ProviderId | null;
  readonly model: string;
  readonly modelPlaceholder: string;
  readonly inheritLabel: string | null;
  readonly baseUrl: string;
  readonly needsBaseUrl: boolean;
  readonly command: string;
  readonly commandPlaceholder: string;
  readonly isCli: boolean;
  readonly onProvider: (next: ProviderId | null) => void;
  readonly onModel: (next: string) => void;
  readonly onBaseUrl: (next: string) => void;
  readonly onCommand: (next: string) => void;
}): React.JSX.Element {
  const descriptor = provider === null ? null : providerDescriptor(provider);

  return (
    <>
    <div className="cc-pair">
      <Field label="Provider">
        <select
          className="cc-select"
          value={provider ?? ""}
          aria-label={`${scope} provider`}
          onChange={(event) =>
            onProvider(event.target.value === "" ? null : (event.target.value as ProviderId))
          }
        >
          {inheritLabel !== null && <option value="">{inheritLabel}</option>}
          {PROVIDERS.map((descriptor) => (
            <option key={descriptor.id} value={descriptor.id}>
              {descriptor.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Model">
        <input
          type="text"
          className="cc-input"
          value={model}
          placeholder={modelPlaceholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${scope} model`}
          onChange={(event) => onModel(event.target.value)}
        />
      </Field>
    </div>

    {descriptor !== null && (
      <p className="cc-hint cc-provider-summary">{descriptor.summary}</p>
    )}

    {/*
      Only for the provider that asks for one. This field decides where an API
      key is sent, so it appears exactly where that is true and nowhere else —
      a base URL box beside a preset would look like it redirected the request
      and would not.
    */}
    {needsBaseUrl && (
      <Field
        label="Base URL"
        hint="HTTPS only. This is where this agent's key is sent."
      >
        <input
          type="url"
          className="cc-input"
          value={baseUrl}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          autoComplete="off"
          aria-label={`${scope} base URL`}
          aria-invalid={baseUrl.trim().length > 0 && !isValidBaseUrl(baseUrl)}
          onChange={(event) => onBaseUrl(event.target.value)}
        />
      </Field>
    )}

    {needsBaseUrl && baseUrl.trim().length > 0 && !isValidBaseUrl(baseUrl) && (
      <p className="agent-notice is-bad">
        Must be an https:// URL with no query, fragment, or embedded password.
      </p>
    )}

    {/*
      A CLI provider runs a program on this machine. The field says so in as many
      words: this is the one setting here whose effect is a process starting
      rather than a request being sent, and the user should not have to infer it.
    */}
    {isCli && (
      <Field
        label="Command"
        hint={`OpenStrawberry runs this program on your machine. Leave blank to use ${commandPlaceholder} from your PATH.`}
      >
        <input
          type="text"
          className="cc-input"
          value={command}
          placeholder={commandPlaceholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${scope} command`}
          aria-invalid={command.trim().length > 0 && !isValidCommand(command)}
          onChange={(event) => onCommand(event.target.value)}
        />
      </Field>
    )}

    {isCli && command.trim().length > 0 && !isValidCommand(command) && (
      <p className="agent-notice is-bad">
        Must be a program name or path — no arguments, and no shell characters.
      </p>
    )}
    </>
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

  // The orchestrator can move from elsewhere — another window, a restore — so
  // the form follows the saved value rather than drifting from it.
  useEffect(() => {
    setOrchestrator(orchestratorDraftFrom(config));
  }, [config.provider, config.model, config.baseUrl, config.command]);

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

          <form
            className="cc-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSaveOrchestrator(orchestrator, config)) return;
              void bridge.setOrchestrator(
                orchestrator.provider,
                orchestrator.model.trim(),
                orchestratorNeedsBaseUrl(orchestrator)
                  ? orchestrator.baseUrl.trim()
                  : null,
                orchestratorIsCli(orchestrator) && orchestrator.command.trim().length > 0
                  ? orchestrator.command.trim()
                  : null
              );
            }}
          >
            <ProviderFields
              scope="Orchestrator"
              provider={orchestrator.provider}
              model={orchestrator.model}
              modelPlaceholder={defaultModelFor(orchestrator.provider)}
              inheritLabel={null}
              baseUrl={orchestrator.baseUrl}
              needsBaseUrl={orchestratorNeedsBaseUrl(orchestrator)}
              command={orchestrator.command}
              commandPlaceholder={defaultCommandFor(orchestrator.provider) ?? ""}
              isCli={orchestratorIsCli(orchestrator)}
              onProvider={(next) =>
                setOrchestrator({
                  provider: next ?? orchestrator.provider,
                  // A model belongs to a provider, so switching providers takes
                  // that provider's default rather than carrying a name the new
                  // one has never heard of.
                  model:
                    PROVIDERS.find((entry) => entry.id === next)?.defaultModel ??
                    orchestrator.model,
                  // Likewise the endpoint and the program: an address or an
                  // executable that belonged to one provider must not silently
                  // become another's.
                  baseUrl: "",
                  command: ""
                })
              }
              onModel={(next) => setOrchestrator({ ...orchestrator, model: next })}
              onBaseUrl={(next) => setOrchestrator({ ...orchestrator, baseUrl: next })}
              onCommand={(next) => setOrchestrator({ ...orchestrator, command: next })}
            />

            <div className="cc-actions">
              <span className="cc-hint">{routeSummary(null, config)}</span>
              <button
                type="submit"
                className="agent-btn"
                disabled={!canSaveOrchestrator(orchestrator, config)}
              >
                Apply
              </button>
            </div>
          </form>
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

              <ProviderFields
                scope="Agent"
                provider={draft.provider}
                model={draft.model}
                modelPlaceholder={draftModelPlaceholder(draft, config)}
                inheritLabel="Follow the orchestrator"
                baseUrl={draft.baseUrl}
                needsBaseUrl={draftNeedsBaseUrl(draft)}
                command={draft.command}
                commandPlaceholder={draftCommandPlaceholder(draft)}
                isCli={draftIsCli(draft)}
                onProvider={(next) =>
                  setDraft({
                    ...draft,
                    provider: next,
                    model: "",
                    baseUrl: "",
                    command: ""
                  })
                }
                onModel={(next) => setDraft({ ...draft, model: next })}
                onBaseUrl={(next) => setDraft({ ...draft, baseUrl: next })}
                onCommand={(next) => setDraft({ ...draft, command: next })}
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
