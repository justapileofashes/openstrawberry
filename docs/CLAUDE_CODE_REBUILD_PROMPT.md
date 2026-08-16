# Claude Code Rebuild Prompt — OpenStrawberry

Copy the following prompt into Claude Code when you need a new coding agent to rebuild, audit, or continue OpenStrawberry.

---

You are continuing **OpenStrawberry**, an open-source, local-first desktop browser for macOS, Windows, and Linux. Treat this as a real Electron product, not a web mockup or a code-only agent tool. Preserve the current repository unless a change is explicitly required. Before editing, inspect `AGENTS.md` from the current directory upward, read the relevant source and tests, and check the root `todo.md`. Do not use destructive Git commands. Never erase unrelated user work.

## Product mission

Build a browser that makes AI assistance feel native to browsing. The product is inspired by the **publicly observable workflow principles** of Strawberry Browser’s Companions: browser-native assistance, explicit selected context, planning before action, bounded delegation to specialists, visible background work, human approval before side effects, and local-first privacy. Do **not** claim or imitate undisclosed Strawberry internals. Implement transparent, original equivalents using Electron, Chromium BrowserViews, explicit permissions, and review-first orchestration.

The project name is **OpenStrawberry**. The native application ID is `io.openstrawberry.browser`. The public repository is `https://github.com/justapileofashes/openstrawberry`.

> **Current public posture:** OpenStrawberry is a work in progress. It has no signed, stable public installer. Keep prominent wording such as **“WORK IN PROGRESS — DO NOT DOWNLOAD YET”** in the README and do not publish or promote unsigned installer builds. Keep all latest-release download links disabled until signed artifacts and verified release metadata exist.

## Non-negotiable product requirements

OpenStrawberry must be a proper searchable, pinnable desktop app installed through platform-native installers—not a website that happens to resemble a browser. The core browser needs real Chromium navigation, real embedded tabs, a browser address bar, loading state, history controls, downloads, session restore, split panes, persistent tab groups, and local workspaces.

Use Electron BrowserViews for real web content. The React renderer is browser chrome only. Guest websites must never have Node access or a path to the app’s internals. Keep Chromium BrowserViews sandboxed, with context isolation enabled, Node integration disabled, restrictive permission handling, and a narrow validated IPC bridge.

The initial blank tab must be `about:blank`, never `https://example.com`. Empty address input may resolve to `about:blank`; regular search text resolves to the configured Google search fallback. Explicit user navigation to `https://example.com` is still ordinary HTTPS browsing and must remain valid. Do not treat the placeholder migration as a general domain block.

## Visual and interaction direction: Obsidian Relay

Use the **Obsidian Relay** visual system. The style is monochrome, motion-aware, and selectively Liquid Glass:

- Near-black browser chrome with clear white and gray text hierarchy.
- Solid, readable page content areas; do not cover arbitrary web pages in low-contrast frosted effects.
- Layered monochrome glass for controls, tab rail, address surface, Agent rail, update panel, migration and approval surfaces.
- The left side is a favicon-only tab rail. Keep it icon-first and provide safe globe fallbacks when no HTTPS favicon can be loaded.
- Workspace controls belong in the top bar. Compact controls use hover and keyboard-focus tooltip bubbles rather than persistent labels.
- The Agent rail and Updates controls are icon-only. Do not restore their persistent text labels.
- Motion and Liquid Glass are always part of the system; do not add Motion or Glass toggles.
- Keep animation intentional, short, interruptible, and accessible. Preserve visible focus states and `prefers-reduced-motion` handling where practical.
- The default Windows File, Edit, View, and Window application menu must be removed, while normal title-bar minimize, maximize, and close controls remain.

The user originally asked for a monochrome Refero-style direction with smooth animation and Liquid Glass. The implementation should feel crafted and browser-native, not like a generic admin dashboard or chatbot.

## Required architecture and security boundaries

| Layer | Responsibilities | Strict boundary |
|---|---|---|
| Electron main process | BrowserViews, session/profile partitions, downloads, migration, media controls, updater, encrypted vault, provider calls, local coding CLIs | Trusted native boundary; owns secrets and OS/process access |
| Preload bridge | Typed, minimal approved APIs for browser, agents, media, updates, and app state | No arbitrary Node, filesystem, shell, or unrestricted IPC access |
| React renderer | Browser chrome, tab rail, top bar, split layout, Agent rail, Agent Control Panel, update panel | Never receives existing raw credentials, filesystem paths, or direct subprocess access |
| BrowserView guest pages | Actual websites | Sandboxed; no Node integration; no renderer DOM access; strict navigation policy |
| Shared contracts | Browser snapshots, runtime validators, agent types, provider and CLI protocols | Deterministic, security-critical, unit tested |

Use runtime IPC validation for every renderer-reachable payload. Verify the sender is the expected trusted renderer. Never accept arbitrary browser schemes, shell commands, CLI executables, URLs that bypass policy, or unvalidated agent profiles.

The shutdown sequence must remain destruction-safe. BrowserView cleanup happens on the BrowserWindow `close` event before window destruction. Removal must tolerate an already-destroyed parent window and be idempotent. Do not add unconditional late `removeBrowserView` calls to a `closed` callback.

## Browser implementation requirements

Use a persistent application-owned Chromium profile partition. The browser manager should own BrowserView creation, attachment/detachment, active-pane handling, viewport changes, navigation, title/favicon/loading/history state, downloads, privacy-state counters, tab groups, workspace snapshots, session persistence, and split panes.

Persist only bounded browser metadata. Session/workspace records may include tab URLs, tab IDs, pane layout, active pane, split state, and tab-group metadata. They must not store or copy cookies, session tokens, account tokens, raw passwords, payment information, or agent keys.

The migration wizard is consent-first. Chromium source detection can show user-selectable import sources. Firefox and Safari imports must rely on manual HTML bookmark exports, not direct access to browser databases. Password imports are reviewed CSV staging only, encrypted with the operating system, never automatically autofilled, and never exposed to agents. Never copy active cookies, sessions, passkeys, or account tokens.

Tracker blocking must remain conservative and transparent, with per-site exceptions and visible bounded counters. Do not market it as a comprehensive blocker. Picture-in-picture and media controls must use supported HTML video/native capabilities only; do not bypass DRM, CAPTCHAs, platform controls, or site restrictions.

## Agent and orchestration requirements

Agents work as browser-native Companions. The user selects context and can inspect it. The system must show a plan before execution, identify side effects and costs, require approval when needed, make sub-agent delegation visible, and return artifacts with clear status. Do not create hidden “agent swarm” behavior.

The Orchestrator creates a typed, reviewable graph for specialists such as Researcher, Coder, and Reviewer. It must preserve dependencies, context boundaries, approval points, and final handoffs. Deep autonomous execution is not an excuse to remove human review.

The top-bar Agent Control Panel creates and edits individual agents. Each agent has a name, role, executor type, provider or local CLI selection, model, optional HTTPS base URL, and its own credential binding. Provider presets include OpenAI, Anthropic, OpenRouter, Moonshot AI, Qwen, OmniRoute, and OpenAI-compatible APIs. Local coding CLI support includes Codex, Claude Code, Qwen Code, Kimi Code, and OpenCode.

Per-agent API keys are non-negotiable. The renderer may submit a newly entered key through the typed bridge but must never read an existing key. The main process stores keys with Electron `safeStorage` in a separate encrypted vault. Raw credentials must never appear in browser snapshots, logs, prompts, errors, artifacts, orchestration plans, renderer state, or test fixtures.

Local CLI execution must remain allowlisted, bounded, main-process-only, and launched with a restricted environment. Do not introduce arbitrary executable paths, arbitrary shell commands, unrestricted inherited environment variables, or renderer-launched processes.

## Updater and release requirements

Use `electron-updater` with a GitHub Releases configuration, but leave it disabled until a signed stable release and verified metadata exist. The UI must accurately represent disabled, checking, available, downloading, downloaded, error, and explicit install/restart states. Users should be able to download and install an available signed update without manually redownloading once the channel is activated.

Do not enable the updater or present public downloads for unsigned builds. A release requires platform-specific signing and verification: Authenticode on Windows, Developer ID signing and notarization on macOS, and signed/verified Linux artifacts with SHA-256 checksums. Windows NSIS, macOS DMG, Linux AppImage, DEB, and RPM assets have stable intended names; check `src/shared/desktop-shell.ts` and `package.json` before changing them.

The Windows NSIS installer is one-click and per-user. Keep `allowToChangeInstallationDirectory` disabled because it is incompatible with one-click mode. Local artifacts under `release/` are ignored build outputs, not public releases.

## Current source map

Read these files before changing the relevant subsystem:

| File | Purpose |
|---|---|
| `src/main/index.ts` | BrowserWindow lifecycle, IPC handlers, app menu, permission policy, updater startup |
| `src/main/browser-manager.ts` | Real BrowserView tabs, splits, session persistence, groups, download/privacy/media behavior |
| `src/main/agent-registry.ts` | Per-agent profiles and encrypted credentials |
| `src/main/provider-runner.ts` | Main-process provider execution and error redaction |
| `src/main/cli-runner.ts` | Local coding-CLI discovery and restricted execution |
| `src/main/orchestrator.ts` | Review-first multi-agent planning graph |
| `src/main/update-manager.ts` | Guarded signed-release updater lifecycle |
| `src/preload/index.cts` | Packaged CommonJS preload bridge; do not convert back to ESM without validating sandboxed packaged Electron |
| `src/renderer/App.tsx` | Browser chrome and panels |
| `src/renderer/styles.css` | Obsidian Relay visual system |
| `src/shared/navigation.ts` | Empty input, `about:blank`, HTTP(S), and scheme policy |
| `src/shared/ipc-validation.ts` | Renderer input validation |
| `docs/ARCHITECTURE.md` | Runtime ownership and trust boundaries |
| `docs/OPENSTRAWBERRY_PLAN.md` | Full research-aligned product plan and inspiration mapping |
| `docs/CLAUDE_CODE_HANDOFF.md` | Detailed current implementation handoff |
| `docs/RELEASES.md` and `docs/UPDATES.md` | Release and updater restrictions |

## Development workflow

Use `pnpm`. Before committing any feature or fix, run:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The current test suite must remain green. Add focused tests with each behavior or security fix. Preserve existing focused tests for navigation, IPC validation, provider and CLI protocols, agent vault behavior, updater state, BrowserView lifecycle behavior, and the favicon policy.

For Windows work, build the NSIS installer locally:

```powershell
pnpm build
pnpm exec electron-builder --win nsis --x64
```

The local installer appears at `release\OpenStrawberry-win-x64.exe`; it is unsigned unless code signing has been configured. Smoke-test the unpacked build by launching `release\win-unpacked\openstrawberry.exe`, wait until it is running, request a normal window close, and require a clean exit. Never silently install the EXE on the user’s machine merely to test it.

For Linux validation, package the AppImage/DEB/RPM and test the unpacked app or AppImage in a virtual display when necessary. macOS DMG and Windows signing/notarization require native release runners and credentials.

## Implementation priorities

1. Preserve the WIP/no-download public posture until signing and release automation are complete.
2. Keep browsing real, secure, and stable before broadening agent autonomy.
3. Preserve explicit user control: selected context, reviewable plan, approvals, cancellation, and meaningful failure/blocked states.
4. Keep secrets and OS capabilities in the main process only.
5. Finish release signing and artifact verification before enabling public updater/download paths.
6. Continue remaining browser fundamentals, permissions/vault center, full migration review UX, native PiP, and production agent execution incrementally with tests.

## Anti-requirements

Do not turn this into a SaaS dashboard, an online-only chatbot, a mock browser, or a generic code-agent launcher. Do not copy hidden Strawberry Browser internals. Do not store secrets in the renderer, logs, fixtures, or plain JSON. Do not bypass browser restrictions, DRM, CAPTCHA, or approval requirements. Do not publish unsigned binaries, hardcode future release URLs, or claim stable availability before signing and verification are complete.

At the end of each change, update `todo.md`, run validation, synchronize the user’s local workspace after publication, and report what was verified versus what still needs platform-specific validation.

---

End of Claude Code rebuild prompt.
