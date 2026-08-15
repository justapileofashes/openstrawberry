# OpenStrawberry Desktop Browser — Research-Aligned Build Plan

## Executive goal

Build **OpenStrawberry** as a local desktop browser for macOS, Windows, and Linux whose agent experience is inspired by the publicly documented behavior of Strawberry Browser’s companions: a persistent browser-native assistant, explicit user context, planning before action, delegated parallel work, background execution while the user keeps browsing, structured artifacts, and confirmation before side effects. OpenStrawberry will not attempt to reproduce undisclosed Strawberry internals. Instead, it will implement the observable workflow patterns using a transparent, local-first architecture with **per-agent credential bindings** and a dedicated **Orchestrator** for complex multi-agent tasks.

The product will retain the approved **OpenStrawberry / Obsidian Relay** visual direction: near-black browser chrome, solid content surfaces, selective Liquid Glass for the Companion, Orchestrator, migrations, permissions, agent task state, and native picture-in-picture controls.

| Confirmed decision | Plan commitment |
|---|---|
| Platforms | macOS, Windows, and Linux from one Electron + TypeScript codebase, tested per platform |
| Browser engine | Local Chromium views, real navigation, profiles, history, tabs, downloads, split panes, and native windows |
| Migration | Consent-first local import; passwords through explicit, protected import; no automatic copying of cookies, active sessions, or account tokens |
| Picture-in-picture | Resizable, draggable, native always-on-top media window with playback controls and honest site/DRM fallback behavior |
| Agent UX | Persistent Companion, user-selected browser context, plan-first workflow, live run state, explicit approval, durable artifacts |
| Multi-agent | Orchestrator dispatches named specialists with distinct credential references, bounded context, typed collaboration, budgets, and approvals |
| Agent sequence | Browser core first; Companion next; specialist orchestration and coding-CLI integration after the browser is stable |
| Installation and updates | Familiar, signed platform-native installers, no account gate at launch, simple first-run wizard, and user-controlled signed updates |

> **Primary design rule:** The user interacts with one trusted Companion, while OpenStrawberry makes all delegation, parallel work, context sharing, costs, approvals, and final artifacts visible. Multi-agent execution must feel like a coordinated browser capability, not a swarm of hidden chats.

## 1. Research findings: publicly observable Strawberry companion model

### 1.1 Evidence classification

The research below distinguishes direct public product claims, release notes, and use-case descriptions from independent demonstrations and reviews. Strawberry’s proprietary agent architecture, exact model routing, internal message schemas, and credential implementation are not publicly disclosed in sufficient detail to reproduce. The plan therefore aligns to **observable behavior and product principles**, not private implementation claims.

| Evidence category | Sources reviewed | How it is used in this plan |
|---|---|---|
| First-party product behavior | Strawberry homepage, getting-started guide, operations/marketing/research/data-extraction use cases, release notes, privacy materials | Defines the Companion, plan-first, parallel-delegation, context, approval, rate-aware, and local-data patterns |
| First-party release details | Latest update and Beta 0.0.87/0.0.90 material | Identifies planner/sub-agent behavior, code/workspace direction, and background resource expectations |
| Independent descriptions | Computerworld launch coverage, DEV Community overview, selected review summaries | Tests whether public workflow claims are recognizable outside company copy; identifies interruption/recovery expectations |
| First-hand demo sources located | Official/insider YouTube demos and founder interviews located in discovery | Used only as corroboration candidates; no unverified implementation detail is treated as fact |

### 1.2 Core companion patterns to match

Strawberry publicly presents its product as an AI browser with **companions** that operate within the user’s browser workspace rather than as a separate chatbot. Its materials describe a personal assistant that learns from onboarding, connected apps, selected tabs, role, habits, protocols, and project conventions; its use cases present the browser as a shared workspace where companions read, browse, and act within web tools.[1] [2] [3] OpenStrawberry must therefore center its agent design on a browser-native Companion with explicit contextual awareness—not primarily on an isolated provider/model chooser.

Strawberry’s latest public update says the agent can plan before acting and spin up sub-agents to handle several parts of a job at once.[4] Its use cases describe parallel work at both a workflow level—multiple agents pulling data from different dashboards—and at an item level—one agent enriching each entry in a dataset.[5] [6] This supports the OpenStrawberry Orchestrator model, but it also implies that the task graph needs to be legible, worker roles must be bounded, and intermediate results need to return as useful artifacts rather than a noisy transcript.

Strawberry positions approval as a core user-control behavior: its getting-started material says drafts are reviewed and updates are flagged for confirmation.[2] Its data-extraction content also says rate-sensitive platforms should be handled at human speed and slowed when pushed back.[7] These claims require OpenStrawberry to make approval and rate policy **scheduler primitives**, not just warning text at the end of a task.

Strawberry’s homepage and privacy materials publicly state that passwords, history, and cookies stay local on the device, with passwords encrypted locally.[1] [8] OpenStrawberry should mirror the **local-first privacy outcome** while going further on credential separation: a website credential vault, migration-password vault, and per-agent provider-key vault must be distinct. Neither agents nor other agents may read raw browser passwords or API keys.

Finally, independent coverage and reviews describe agents that open tabs, click, fill forms, research in parallel, and can be interrupted by real-web friction such as CAPTCHAs, refreshes, and blocked steps.[9] [10] This means a companion-aligned product needs a visible “blocked / needs you” state, browser snapshots, resume-after-user-intervention behavior, and a transparent failure record.

## 2. Strawberry-to-OpenStrawberry alignment matrix

| Publicly documented/observed Strawberry pattern | OpenStrawberry implementation decision | More explicit OpenStrawberry safeguard |
|---|---|---|
| Persistent personal Companion works from the browser and user tabs | Primary **Companion** rail is persistent, context-aware, and available in every workspace | Context must be selected, previewed, and revocable; tabs are not silently shared |
| Onboarding learns role, connected apps, and working conventions | First-run Companion setup captures role, workspaces, preferred outcomes, allowed apps/sites, tone, and approval preferences | Store memory locally; user can inspect, edit, pause, export, or delete every memory entry |
| Companion plans before acting | Every task begins with an execution preview: objective, steps, selected context, expected artifacts, worker roles, budget, and side effects | Side effects remain blocked until approval; user can edit or decline any plan node |
| Sub-agents handle parts of a job in parallel | Orchestrator produces a dependency graph and dispatches bounded specialist work items | Per-worker context grants, separate credentials, concurrency cap, and run-wide budget |
| Multiple agents extract/enrich data across sites | Researcher/Data Extractor templates can open agent-owned work tabs and publish structured artifacts | Rate-aware scheduler, per-domain concurrency limits, provenance, and user-visible site-access policy |
| User can continue browsing while companion works | Runs execute in background, with compact state in the control strip and a detailed agent timeline in the rail | User can pause, cancel, inspect, or take over a blocked task without losing their current tab |
| Drafts and data updates require confirmation | Draft/review/approval states are first-class in the run graph | Scoped approvals, payload digest, expiry, audit record, and immutable approval boundaries |
| Passwords/history/cookies are local | Local encrypted browser profile and vaults | Separate website-password store from agent-key vault; no credential value enters prompts, logs, or artifacts |
| Real websites can interrupt execution | Explicit `Needs user` / `Blocked` node with site snapshot and reason | Resume only after user action; no CAPTCHA bypass or opaque retry loop |

## 3. Product architecture: real local browser first

OpenStrawberry will be a local Electron desktop application, not a hosted website. The hardened main process will own native browser views, profiles, storage, downloads, migration, media windows, the key vault, and the agent scheduler. The renderer will own the Liquid Glass browser chrome and Companion experience. Guest pages will run in sandboxed Chromium web contents without Node integration. A minimal typed preload bridge exposes only approved capabilities to the renderer.[11] [12] [13]

| Layer | Responsibilities | Trust boundary |
|---|---|---|
| Main process | Chromium views, tabs, sessions, profiles, downloads, migration, native PiP, vault, scheduler, agent adapters | Trusted code only; owns OS/keychain/process access |
| Preload bridge | Typed commands/events for browser and agent UI | No arbitrary IPC or filesystem access |
| Browser renderer | Tab strip, pane tree, address bar, Companion rail, orchestration views, settings | Receives metadata and signed/validated events, never raw secrets |
| Guest web pages | Real user websites | Sandboxed; separate from OpenStrawberry internals and agent control plane |
| Companion/orchestrator engine | Planning, context bundles, task DAG, typed worker messages, artifact ledger | Can request capability; cannot self-grant profiles, secrets, or side effects |
| Agent adapters | Provider calls or local coding CLI runs | Receive only one agent’s credential reference and role-scoped context |

## 4. Browser fundamentals and standard browser features

### 4.1 Native browsing foundation

The browser milestone creates actual page rendering with editable address entry, URL normalization, search fallback, real navigation, history, reload/stop, page title and favicon updates, downloads, bookmarks, profiles, private sessions, permission prompts, session restore, reader mode, keyboard shortcuts, zoom, find-in-page, print, and local privacy settings.

Every tab is a persistent record with its own URL, history, title, favicon, load state, mute state, zoom, profile/session partition, group/workspace metadata, and Companion context eligibility. A tab is never merely a mock rectangle in the renderer; it maps to a real embedded Chromium view controlled by the main process.

### 4.2 Drag-to-split tabs and workspaces

OpenStrawberry will use a persisted **pane tree**. Leaf panes each own an active tab stack; internal tree nodes represent horizontal or vertical splitters. This supports single browsing, side-by-side research, stacked views, and up to four simultaneous panes in the first release.

When dragging a tab, directional targets appear over a target pane: left, right, top, bottom, center, and new window. Edge drops split the pane; center drops add a tab to that pane; the new-window target creates a separate browser window. Pointers resize dividers, double-click equalizes panes, keyboard shortcuts move focus, and workspace snapshots preserve the complete arrangement. The Companion must never silently read every visible pane: the user selects a pane, tab, or a named workspace snapshot as context.

### 4.3 Profiles, migrations, and browser credentials

The first-run wizard detects locally installed browsers and displays only valid source profiles. The user chooses a source browser, profile, and categories to import. Bookmarks, history, selected preferences, and optionally autofill data can be imported from read-only snapshots. Password import requires a separate consent step and uses supported local credential access or a user-selected exported-password file. Cookies, active login sessions, and account tokens are deliberately excluded; users sign in again.

| Data class | OpenStrawberry policy |
|---|---|
| Bookmarks/history/preferences | Local, user-selected import with receipt and deletion option |
| Browser passwords | Explicit protected import; isolated browser-password vault; no agent read access |
| API keys for agents | Explicit per-agent encrypted vault entries; never shown in browser-password import or browser autofill |
| Cookies, sessions, passkeys, account tokens | Never automatically copied or transformed; user reauthenticates |
| Extensions | Optional discovery/recommendation only; no silent copying of binaries or permissions |

## 5. Native always-on-top picture-in-picture

OpenStrawberry will create a separate native picture-in-picture window for supported video. The window is resizable from any edge or corner, draggable from its application chrome, persists its geometry, can remain above other desktop windows, and includes play/pause, seek/scrub bar, frame-step controls, elapsed/remaining time, volume, mute, playback speed, return-to-tab, close, and always-on-top toggle.

The implementation uses a two-mode media strategy. Standard controllable HTML5 video receives an OpenStrawberry-managed pop-out when playback synchronization is reliable. Sites with a more reliable native PiP are routed to native PiP. DRM, opaque players, and site-restricted controls receive an honest fallback—native site PiP where available or a pinned dedicated browser window. No DRM controls or web-page restrictions will be bypassed.

## 6. Companion-centered agent experience

### 6.1 The primary Companion

The primary Agent button opens a **Companion** rail rather than a generic model selector. It is always browser-aware, but it is not always browser-authorized. The Companion’s top section shows selected context, current task, task plan, plan state, agent roster, budget, and approval status. Its lower section is a composer that lets the user ask for research, extraction, drafting, planning, code handoff, or browser workflow assistance.

The Companion follows this default loop:

1. **Understand:** Identify the requested outcome and show the user which tabs, files, repositories, saved memories, and browser profile are available.
2. **Plan:** Produce a compact human-readable plan and a structured task graph. Mark likely reads, writes, new domains, credentials, costs, and irreversible actions.
3. **Confirm:** Start read-only work after user confirmation; require extra approval for any protected side effect.
4. **Delegate:** For complex tasks, request the Orchestrator to assign limited worker roles.
5. **Work in background:** Open labeled agent work tabs or isolated agent panes; show live state without blocking browsing.
6. **Return:** Deliver a concise answer plus structured artifacts, citations/provenance, uncertainties, and next actions.
7. **Remember only with permission:** Offer to save a protocol, preference, or reusable skill locally; never silently create broad personal memory.

### 6.2 Browser-native context and agent work tabs

Selected tabs become context objects with URL, title, page snapshot/extract, timestamp, profile, sensitivity label, and explicit permission state. The Companion can request tabs but cannot add them to a run without user confirmation. For browser tasks, worker agents may open their own **Agent work tabs** in a distinct tab group. Users can watch, pause, close, or take over these tabs, ensuring the product matches the “works in your browser while you continue working” experience described publicly for Strawberry.[1] [3]

Agent work tabs expose a compact execution ribbon: task name, worker role, allowed domains, current step, rate state, last safe checkpoint, and `Pause`, `Take over`, `Stop`, and `Review` controls. A user intervention such as login, CAPTCHA, changed form, or unexpected page state creates a `Needs user` checkpoint; execution does not attempt to bypass it.

## 7. Multi-agent registry, per-agent API keys, and Orchestrator

### 7.1 Side-panel modes

The left-side **Agents** entry opens a dedicated panel with three modes:

| Mode | Purpose | Visible controls |
|---|---|---|
| **Agents** | Create and manage named specialists | Role, provider/CLI, model, credential status, browser/file scope, policy, budget, test connection, disable/revoke |
| **Orchestrate** | Turn a complex request into an approved multi-agent plan | Goal, selected context, suggested roster, work graph, parallelism, cost/time cap, side effects, approval policy |
| **Runs** | Monitor and audit active/completed work | Task DAG, worker state, messages, agent tabs, artifacts, costs, timeline, approval gates, retry/cancel |

The first templates are **Companion**, **Orchestrator**, **Researcher**, **Data Extractor**, **Coder**, and **Reviewer**. The user may choose named providers, local CLIs, models, and dedicated API-key entries for each. The Orchestrator is a control-plane agent with its own credential reference; it never receives other agents’ raw API keys.

### 7.2 Per-agent credential design

Every agent profile points to one **CredentialRef** held in the encrypted desktop vault. A CredentialRef may represent an OpenAI key, Anthropic key, Moonshot key, Qwen key, OpenRouter key, OmniRoute/local-gateway token, another compatible API key, or supported local CLI authentication state. The renderer receives only status metadata. Raw credentials are never copied into prompts, browser tabs, agent messages, logs, artifacts, analytics, or error reports.

The default is one distinct credential binding per agent. If the user chooses to associate several agents with the same credential, the interface must prominently label it as a shared security and billing boundary and ask for confirmation. Credentials can be rotated, disabled, or revoked; affected work pauses safely rather than silently substituting another credential.

| Secret-vault invariant | Enforcement |
|---|---|
| Agent cannot reveal or request another agent’s raw key | Keys are never materialized in agent context; only the adapter receives an in-memory secret at call time |
| Browser passwords are separate from provider keys | Different vault namespaces and capability APIs; agents have no browser-password read method |
| Renderer cannot read secret values | Main-process-only vault operations through allowlisted preload calls |
| A revoked key cannot continue a run | Adapter checks credential state before each request; scheduler pauses dependent nodes |
| Secret cannot land in an artifact or log | Central redaction pipeline and schema validation reject secret-shaped values |

### 7.3 Orchestrator model

The Orchestrator makes multi-agent work look like a Companion’s delegated plan rather than a hidden swarm. It receives the user’s goal and explicitly selected context, then proposes a dependency graph: work items, chosen roles, per-worker context subset, expected artifact format, budget, rate policy, and potential approval gates. The user reviews this plan before worker deployment.

Workers communicate only through a main-process-managed **run-scoped message bus**. They exchange typed assignments, statuses, clarification requests, artifact references, review requests, and escalations. They do not engage in unrestricted direct chat, access each other’s provider sessions, see each other’s API keys, or expand their context beyond the immutable grant. This enables coordination while controlling message volume, privacy, and scope drift.

| Typed message | Purpose | Required controls |
|---|---|---|
| `TaskAssignment` | Give a worker one bounded unit of work | Context IDs, expected schema, budget, policy, deadline |
| `ClarificationRequest` | Ask an owner or Companion for a missing safe decision | Minimal evidence only; blocks further execution |
| `StatusUpdate` | Report live stage/progress | Rate-limited, redacted, user-visible summary |
| `ArtifactPublished` | Provide output to downstream work | Provenance, integrity hash, sensitivity label, schema validation |
| `ReviewRequest` | Request independent checking | Target artifact and test/checklist |
| `Escalation` | Flag policy, cost, trust, site, or permission problem | Severity, safe alternatives, affected scope |
| `Completion` | Close a work item | Outcome, limitations, outputs, retry recommendation |

### 7.4 Collaboration patterns

| User objective | Orchestrator graph | Result |
|---|---|---|
| Research a product and prepare a coding change | Researcher reads selected tabs → Data Extractor normalizes facts → Planner creates spec → Coder uses isolated worktree → Reviewer checks diff/tests | User receives a source-backed brief, candidate diff, and test review |
| Compare model providers | Researcher gathers official documentation → Analyst compares capabilities → Reviewer checks citations → Companion drafts recommendation | Decision artifact with provenance, caveats, and provider/config suggestions |
| Extract and enrich a list | Data Extractor creates base list → bounded enrichment workers handle items in parallel → Reviewer samples/validates → Companion compiles output | Structured table with source URLs, confidence, and deduplication notes |
| Publish a workflow result | Researcher/Writer draft → Reviewer checks content → Policy worker validates action → Publisher waits at approval | Exact final payload and target remain user-approved before sending |

### 7.5 Approval, rate policy, and recovery

OpenStrawberry will match Strawberry’s public emphasis on approvals and rate-sensitive browsing, but will make these controls inspectable. Every run has a global time/cost cap, worker-level token/request cap, maximum parallelism, per-domain rate policy, retry limit, and explicit side-effect list. The scheduler slows or serializes actions on marked rate-sensitive domains, pauses after site pushback, and shows the reason in the run timeline.[7]

The following actions always require a user approval even if a prior plan exists: sending/publishing, creating or updating external records, downloading unknown executables, changing browser/agent permissions, using a new credential, entering a new browser profile, writing outside an approved worktree, deleting data, expanding context/domains, or executing a financial action. No worker may self-authorize a policy change.

## 8. Implementation roadmap

### Phase A — Native browser foundation

1. Bind a local development folder; initialize a hardened Electron + TypeScript + React desktop project.
2. Move the approved OpenStrawberry Liquid Glass shell into the native renderer.
3. Create tab/session/profile primitives, embedded Chromium view lifecycle, URL handling, real navigation, permission prompts, downloads, and browser data storage.
4. Add packaging configurations and a test matrix for macOS, Windows, and Linux.

### Phase B — Browser completeness and organization

1. Implement history, bookmarks, private sessions, reader tools, find/zoom/print, download manager, session restore, profiles, privacy center, and keyboard shortcuts.
2. Implement the pane-tree model, tab dragging, split targets, resizable dividers, vertical tabs, groups, pinned tabs, workspace snapshots, and new-window behavior.
3. Build consent-first browser migration, local source-profile discovery, selected-category import, protected password import, receipts, and data deletion.

### Phase C — Native picture-in-picture

1. Implement media discovery, tab media controls, and a native resizable always-on-top video window.
2. Add playback, seek, frame-step, volume, mute, speed, return-to-tab, close, and persistent geometry.
3. Validate standard HTML5 media, YouTube, native-PiP sites, and protected-media fallbacks without bypassing site or DRM restrictions.

### Phase D — Companion core, companion memory, and browser work tabs

1. Build the persistent Companion rail, context picker, visible plan, task queue, selected-tab grants, status timeline, approval cards, artifact shelf, and user-intervention checkpoints.
2. Implement local opt-in Companion memory/skills: role, protocols, writing conventions, recurring task templates, and approval preferences. Provide inspect/edit/delete/export controls.
3. Implement Agent work tabs with task ribbons, allowed-domain display, rate status, checkpoint/recovery, and take-over controls.

### Phase E — Vault, specialist registry, and Orchestrator

1. Implement an OS-protected local vault with separate namespaces for browser credentials, imported passwords, and agent/provider credentials.
2. Build **Agents / Orchestrate / Runs** panel modes, agent templates, per-agent credential bindings, connection tests, budgets, policy scopes, provider/CLI configuration, and revocation.
3. Implement the structured orchestration-plan preview, run-scoped message bus, artifact ledger, dependency-graph scheduler, concurrency/rate controls, and kill switch.
4. Launch the initial specialist set: Orchestrator, Researcher, Coder, and Reviewer. Begin with three concurrent workers maximum and artifact-mediated handoffs only.

### Phase F — Local coding CLI and provider rollout

1. Add adapters one at a time for the supported coding CLIs using their documented structured/headless routes where available.
2. Add native provider and compatible gateway adapters, with per-agent model and base-URL configuration constrained to verified capabilities.
3. Default coding work to isolated worktrees, reviewable diffs, test artifacts, and user-approved commit candidates.

### Phase G — Hardening, validation, and packaging

1. Run threat modeling for guest pages, migration, browser permissions, secrets, Companion memory, agent prompts, message bus, local CLIs, and side effects.
2. Add unit, integration, end-to-end, visual, accessibility, migration-fixture, and agent-policy tests.
3. Build platform installers, signing/notarization pipelines as appropriate, local data export/delete features, and first-run guidance.

## 9. Acceptance tests

| Area | Completion criterion |
|---|---|
| Real browser | Public websites render in native Chromium views; tabs, back/forward/reload, history, profiles, downloads, and private sessions work independently |
| Split panes | Tab drag creates directional same-window splits; ratios persist; each pane has independent tab history and selected context |
| Migration | Source browser is detected; user selects categories; source remains unchanged; receipt shows imported/skipped data; password fixtures never appear in logs |
| PiP | Supported video opens in a resizable draggable native always-on-top window with accurate control synchronization and clear fallback states |
| Companion parity | User can select tabs, see a plan, let work proceed in background, observe agent work tabs, receive artifacts, and pause/take over blocked steps |
| Parallel work | Orchestrator produces reviewable graph; bounded workers run in parallel; artifacts merge through typed handoffs; domain rate limits are obeyed |
| Credential isolation | One agent cannot read another agent’s key; no raw secret reaches renderer, prompts, logs, or artifacts; revocation pauses affected work |
| Approval | Sending, publishing, sensitive browser actions, new credentials, context expansion, and external writes stop at a clear approval card |
| Recovery | CAPTCHA/login/site change creates `Needs user` state with snapshot and no bypass attempt; user can resume/cancel safely |
| Accessibility | Full keyboard control for tabs, split panes, Companion, Agent work tabs, dialogs, PiP controls, and reduced-motion/reduced-transparency behavior |

## 10. Risks and explicit limits

| Risk or unknown | Planned response |
|---|---|
| Strawberry’s internal implementation is not public | Match observable workflow and user-control patterns; do not claim reverse-engineered parity |
| Browser migration secrets are platform encrypted | Use explicit native/authorized import or export-file fallback; never silently copy sessions |
| Different coding CLIs expose different configuration interfaces | Capability-detect per CLI; hide unsupported provider/key options rather than suggesting false compatibility |
| Multi-agent costs or retries can run away | Per-agent/run budgets, concurrency caps, retry limits, rate policy, manual pause/cancel, and kill switch |
| Agent prompts or pages attempt to exfiltrate context/secrets | Immutable context grants, typed redacted message bus, no raw keys/passwords in context, and user approval for scope expansion |
| Site automation can trigger CAPTCHA/anti-bot systems | Human-rate policy, user-intervention checkpoints, no CAPTCHA bypass, and recovery timeline |
| Always-on-top/PiP behavior varies across OSes and sites | Per-platform validation, saved safe geometry, native/site PiP fallback, and transparent compatibility notices |

## 11. Assumptions and next operational prerequisite

1. A local development folder will be bound before implementation. The production browser must be developed, launched, and tested as a native desktop application.
2. The current visual style is accepted as the OpenStrawberry desktop style. The Companion, Orchestrator, run graph, split drop targets, migration wizard, and PiP controls will extend it rather than replace it.
3. Browser fundamentals and Companion behavior ship before broad autonomous browser operation. The first multi-agent release is transparent, local, bounded, approval-gated, and artifact-mediated.
4. All browser passwords, user accounts, API keys, and migrated data remain local unless the user explicitly authorizes an external action. Provider API calls receive only the data selected for that agent task.

## 12. Installation, updates, and frictionless first launch

OpenStrawberry will be distributed as a familiar native desktop application—not as a developer archive that requires a terminal or manual runtime setup. The release page will identify the user’s operating system and architecture by default, show a single primary **Download OpenStrawberry** action, and retain an explicit selector for macOS, Windows, Linux, Intel/AMD64, and ARM64 choices. Each release will include a versioned installer, release notes, signed update metadata, and published checksum for users or organizations that require independent verification.

### 12.1 Installer experience by platform

| Platform | Primary installer | First-use experience | Required trust and update work |
|---|---|---|---|
| macOS | Universal `.dmg` with drag-to-Applications flow; managed `.pkg` offered for organizations | User opens OpenStrawberry from Applications; short welcome flow starts without mandatory account creation | Developer ID signing, notarization, stapling, and signed update feed; macOS auto-update requires a signed app.[14] [15] |
| Windows | Per-user signed `.exe` installer with Start-menu entry, desktop shortcut option, uninstall entry, and automatic update channel | One guided installer; no administrator prompt unless the user chooses all-users install | Authenticode signing, publisher identity, signed update feed, and clear SmartScreen-compatible publisher details |
| Linux | AppImage for the simplest portable double-click path; `.deb` and `.rpm` for distribution-native installation; Flatpak considered after first release | AppImage launches after executable permission where required; package installs integrate with application menus | Signed repository metadata or checksum/GPG verification; update behavior varies by package channel and is shown clearly |

The initial packaging toolchain will generate these artifacts from the same locked application version, but release signing will occur on secure platform-appropriate build runners. Electron packaging tooling supports native makers/installers and update workflows; the chosen release pipeline will use only supported target formats and will fail closed if signing metadata is missing for a production channel.[14] [16]

### 12.2 First launch and migration flow

Installation must lead directly to a useful browser, not a configuration maze. The first launch uses a short, skippable five-step wizard. Each page includes a **Skip for now** option and a clear return path from settings.

1. **Welcome:** Explains that OpenStrawberry is local-first and can be used immediately without creating an external account.
2. **Migration choice:** Detects installed browsers and asks whether to migrate now, later, or not at all. The data categories remain explicit and local-only.
3. **Profile and privacy:** Selects a local profile name, default search engine, theme/motion preference, private-browsing behavior, and browser data retention defaults.
4. **Optional Companion setup:** Lets the user postpone all provider keys, local coding CLIs, and agent permissions; the browser opens normally even when no agent is configured.
5. **Start browsing:** Opens a clean OpenStrawberry start page with a visible `New tab`, `Import browser data`, `Open settings`, and `Meet your Companion` pathway.

The user will never be forced to set OpenStrawberry as the default browser, sign into an external account, import passwords, configure agents, or enable telemetry in order to begin browsing. A user-initiated default-browser request is presented only after the browser has launched successfully and the user chooses it from onboarding or settings.

### 12.3 Updates and recovery

OpenStrawberry will check a signed update manifest in the background after launch and at a bounded interval while running. The application will not interrupt active migrations, downloads, picture-in-picture playback, unsaved agent approvals, or in-progress coding runs. When an update is ready, a compact control-strip notice shows `Restart to update`, `Install tonight`, and `Later`. Security-critical updates may be labeled prominently but cannot install without the user’s confirmation unless the user has explicitly enabled automatic security updates.

The update process will download to a verified staging location, validate manifest signature/version/checksum, retain the previously working app version until the new version passes startup, and offer an obvious recovery/rollback path if the update fails. Browser profiles, vault keys, tabs, downloads, and agent records are stored in versioned migrations; application updates must never overwrite or downgrade user data.

### 12.4 Distribution and release process

| Release stage | Scope | User-facing behavior |
|---|---|---|
| Development | Unsigned local builds for engineering and automated tests | Not distributed to end users |
| Preview | Signed opt-in channel for early testers | Clearly labeled preview; separate profile/data path by default |
| Stable | Signed and verified platform installers | Default download on release page; normal in-app update channel |
| Emergency security patch | Narrow, signed high-priority release | Prominent update notice with release note explaining the fix category |

The release pipeline will build on macOS, Windows, and Linux workers; run automated smoke tests on each artifact; validate install, launch, uninstall, update, deep link/open-URL registration, and profile persistence; sign or notarize artifacts; generate checksums; and publish only after all platform gates succeed. Versioned release notes will describe browser changes, migration changes, permission changes, Companion/agent changes, known limitations, and any data migrations.

### 12.5 Installation acceptance criteria

| Area | Completion criterion |
|---|---|
| Download | The release page presents one correct default download plus visible alternatives for every supported OS/architecture |
| Install | A non-technical user can install and open OpenStrawberry without a terminal on supported macOS, Windows, and major Linux package paths |
| Trust | Production macOS and Windows builds are signed; macOS build is notarized; Linux artifacts have verifiable checksums/signature guidance |
| First run | User can reach a functioning new tab within the short wizard without account, migration, agent, or telemetry enrollment |
| Update | A signed update downloads, waits safely for user restart, preserves profile/vault data, and can recover from a failed launch |
| Uninstall | App uninstall does not silently erase browser profiles or vault data; user sees an explicit optional data-removal choice |

## References

[1]: https://strawberrybrowser.com/ — Strawberry Browser homepage; built-in companions, shared browser workspace, local password/history/cookie claims.

[2]: https://strawberrybrowser.com/use-cases/getting-started — Strawberry getting-started workflow; onboarding and approval descriptions.

[3]: https://strawberrybrowser.com/use-cases/operations — Strawberry operations use case; parallel multi-platform work and compiled output.

[4]: https://strawberrybrowser.com/updates/latest — Strawberry latest update; plan-before-action and sub-agent claims.

[5]: https://strawberrybrowser.com/use-cases/data-extraction — Strawberry data-extraction workflow; per-item parallel enrichment and rate-sensitive behavior.

[6]: https://strawberrybrowser.com/use-cases/marketing — Strawberry marketing use case; parallel gathering and consolidated report workflow.

[7]: https://strawberrybrowser.com/use-cases/data-extraction — Strawberry rate-sensitive platform and slowdown claims.

[8]: https://strawberrybrowser.com/legal/privacy-policy — Strawberry privacy policy; local on-device storage details.

[9]: https://www.computerworld.com/article/4133392/swedish-ai-browser-strawberry-now-available-to-everyone.html — Independent launch coverage of Strawberry browser-agent capability.

[10]: https://dev.to/playfulprogramming/strawberry-ai-browser-will-blow-your-mind-17pk — Independent overview of Companions and approval-based actions.

[11]: https://www.electronjs.org/docs/latest/api/browser-window — Electron BrowserWindow APIs and native always-on-top behavior.

[12]: https://www.electronjs.org/docs/latest/api/web-contents — Electron webContents navigation and new-window handling.

[13]: https://www.electronjs.org/docs/latest/breaking-changes — Electron view architecture and current migration notes.

[14]: https://www.electronforge.io/advanced/auto-update — Electron Forge auto-update documentation and signing prerequisite.

[15]: https://www.electronjs.org/docs/latest/tutorial/code-signing — Electron code-signing guidance for macOS and Windows.

[16]: https://www.electron.build/ — Electron Builder packaging, distribution, and auto-update overview.
