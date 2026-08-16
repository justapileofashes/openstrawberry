# OpenStrawberry — Claude Code Handoff

## Purpose

OpenStrawberry is a local-first, open-source desktop browser inspired by the publicly observable workflow of Strawberry Browser’s browser-native Companions. It is not a copy of undisclosed Strawberry internals. The project implements transparent equivalents: a real Chromium browser shell, visible context selection, review-first planning, bounded multi-agent orchestration, per-agent credentials, and provider or local coding-CLI execution paths.

The product is intentionally **work in progress**. It is not a stable public release. Do not present or recommend the unsigned local installer artifacts as production downloads. The public repository should prominently tell visitors not to download yet until platform signing, release provenance, and installer validation are complete.

## Repository and local workspace

The public repository is `https://github.com/justapileofashes/openstrawberry`. The user-provided Windows workspace is:

```text
D:\docs\claudecodeprojects\openstrawberry
```

The local workspace is a Git clone with `origin` pointing to the public repository. It contains the same source tree as `main`; generated artifacts such as `release/`, `dist/`, and `node_modules/` are local build outputs and must not be committed.

When implementing future changes, update both the sandbox source and the user’s local workspace. Prefer publishing the source change to `main`, then fast-forwarding the local workspace. Never silently overwrite unrelated local changes; inspect `git status` first and ask before discarding work.

## Product identity and design direction

The product name is **OpenStrawberry**. The native identity is `io.openstrawberry.browser`. The visual language is called **Obsidian Relay**: a near-black monochrome browser workspace with restrained white and gray hierarchy, high-contrast typography, selective Liquid Glass surfaces, and motion that communicates state rather than decoration.

The design inspiration combines the user’s request for a monochrome, animated, Liquid Glass interface with the reference-driven product polish associated with modern browser workspaces and the user’s requested Strawberry Browser / Companions workflow. The browser canvas should remain readable and content-first. Glass is used for browser chrome, compact controls, tooltips, the Agent rail, orchestration surfaces, migration, permissions, update notices, and other stateful panels—not as a low-contrast treatment over every webpage.

The left tab rail is favicon-first and icon-only. Workspace controls live in the top bar. Compact buttons use hover and keyboard-focus text bubbles instead of persistent labels. Motion and Liquid Glass are always enabled; there are no user-facing Motion or Glass toggles. Agent and Updates top-bar triggers are icon-only while retaining semantic labels and tooltips.

Keep the visual system accessible: visible focus states, readable contrast, keyboard reachability, responsive minimum desktop width, reduced-motion support where practical, and no interaction that depends on color alone.

## Runtime architecture

OpenStrawberry is an Electron + Vite + React + TypeScript desktop application. Electron 43.4.0 runs the native main process and Chromium. React 19 renders the browser chrome. Vite builds the renderer. `pnpm` is the package manager and direct dependencies are pinned to exact versions.

| Layer | Responsibilities | Security rule |
|---|---|---|
| Main process | BrowserViews, profiles, sessions, downloads, migration, native windows, agent vault, provider calls, local CLI processes, updates | Trusted native boundary; owns secrets and OS access |
| Preload | Narrow typed browser/app/agent/update bridge | No arbitrary Node APIs; validate every renderer-reachable operation |
| Renderer | Browser chrome, tab rail, split layout, Agent rail, Control Panel, update panel | Untrusted presentation layer; never receives raw credentials |
| Guest BrowserViews | Real user websites rendered by Chromium | Sandboxed, no Node integration, no access to OpenStrawberry internals |
| Shared modules | Runtime validation, navigation policy, browser snapshots, provider/CLI protocols | Keep contracts deterministic and unit tested |

Important files:

| File | Role |
|---|---|
| `src/main/index.ts` | Main-process startup, BrowserWindow, permission denial, IPC registration, updater startup, Windows menu removal, shutdown lifecycle |
| `src/main/browser-manager.ts` | BrowserView lifecycle, real tab navigation, split panes, session restore, tab groups, downloads, privacy blocking, media commands |
| `src/main/agent-registry.ts` | Per-agent metadata and OS-encrypted credential vault |
| `src/main/provider-runner.ts` | Main-process provider API execution and error redaction |
| `src/main/cli-runner.ts` | Bounded local coding-CLI discovery and execution |
| `src/main/orchestrator.ts` | Review-first typed multi-agent planning graph |
| `src/main/update-manager.ts` | Signed-GitHub-Releases-only update state machine |
| `src/preload/index.cts` | CommonJS preload bridge used by packaged sandboxed Electron |
| `src/renderer/App.tsx` | Browser chrome, favicon tab rail, top bar, Agent rail, Control Panel, update panel |
| `src/renderer/styles.css` | Obsidian Relay and Liquid Glass renderer styles |
| `src/shared/navigation.ts` | Address normalization and allowed navigation schemes |
| `src/shared/ipc-validation.ts` | Runtime validation for renderer input |
| `src/shared/agent.ts` | Agent profile types and redacted metadata contracts |
| `src/shared/provider-protocol.ts` | Provider presets and endpoint policy |
| `src/shared/cli-protocol.ts` | Local CLI contracts and invocation policy |
| `src/shared/desktop-shell.ts` | App identity and stable release asset names |

## Browser behavior

Each tab maps to a real sandboxed `BrowserView`, not a mock rectangle. The browser manager uses the persistent app-owned partition `persist:openstrawberry-default`. The renderer reports pane bounds; the main process attaches visible BrowserViews to those bounds. Inactive views remain managed but detached.

The default first-launch tab is now `about:blank`, not `https://example.com`. `about:blank` is the only non-HTTP(S) URL allowed by the navigation policy. Explicit user navigation to `https://example.com` remains valid and must not be blocked; only implicit startup and fallback defaults changed.

Session restore preserves bounded tab URLs, tab IDs, panes, active pane, split state, privacy settings, and tab-group metadata. It does not copy cookies, active sessions, passwords, payment information, or account tokens. Empty session/workspace fallback URLs must remain `about:blank`.

The BrowserWindow shutdown path is destruction-safe. BrowserView removal happens from the window’s `close` lifecycle before destruction, is guarded when the parent window is already destroyed, and is idempotent. Do not reintroduce unconditional `removeBrowserView` calls from a late `closed` handler.

## Agent model

The primary Agent rail is a browser-native Companion surface, not merely a model selector. The user selects context, sees a reviewable plan, approves bounded work, and receives artifacts and status. The Orchestrator creates a typed graph for Researcher, Coder, Reviewer, and related roles. Delegation must be visible, bounded, auditable, and interruptible.

The Agent Control Panel is opened from a top-bar icon. It creates and edits profiles with a role, executor, provider, model, optional HTTPS base URL, and per-agent credential. Supported provider presets include OpenAI, Anthropic, OpenRouter, Moonshot AI, Qwen, OmniRoute, and OpenAI-compatible APIs. Supported local CLI adapters include Codex, Claude Code, Qwen Code, Kimi Code, and OpenCode.

Each agent has a separate credential binding. The renderer may submit a new credential through the narrow bridge but never receives the saved raw value back. The main process stores encrypted credentials through Electron `safeStorage` in an OS-protected vault. Profile metadata is separate from encrypted credential material. Raw keys must not enter prompts, logs, artifacts, snapshots, orchestration plans, or browser context.

Local CLI execution is allowlisted, bounded, and launched from the main process with a restricted environment. Do not add arbitrary shell execution, arbitrary executable paths, unrestricted environment inheritance, or renderer-side subprocess access.

## Updates and release posture

The in-app updater is configured for signed GitHub Releases but is disabled until a stable signed release and verified metadata are available. The renderer shows disabled, checking, available, downloading, downloaded, and error states. Download and install are explicit user actions; a ready update can be installed with restart rather than requiring a manual installer redownload.

Do not enable the update channel merely because an unsigned artifact exists. A real release requires platform signing and provenance: Authenticode for Windows, Developer ID signing and notarization for macOS, and verified Linux release artifacts plus checksums. The repository must not advertise unsigned binaries as stable downloads.

The current Windows NSIS output is a local unsigned artifact at `release/OpenStrawberry-win-x64.exe`. It is for local testing only. Do not commit it or publish it as a stable download.

## Migration, privacy, and security

The first-run migration flow is consent-first. Chromium bookmark/profile discovery and manual Firefox/Safari HTML bookmark import are read-only and reviewable. Password CSV staging is explicit, OS-encrypted, never autofilled automatically, and never exposed to agents. Cookies and active account sessions are not copied. Permissions are denied by default. Navigation is restricted to HTTP(S) plus the exact internal `about:blank` startup page. Guest BrowserViews use context isolation, disabled Node integration, sandboxing, and no insecure content allowance.

Tracker blocking is conservative, transparent, and user-controllable. It uses a bounded policy and per-site exceptions rather than pretending to be a complete ad blocker. Never claim comprehensive blocking. Media controls act only on compatible HTML video and honest native picture-in-picture capabilities; do not bypass DRM, CAPTCHAs, or site restrictions.

## Testing and validation

The repository currently has 54 tests across 19 test files. Main-process tests cover IPC security, agent registry, provider runner, CLI runner, migration, orchestrator, and update manager. Shared tests cover navigation, browser workspace, IPC validation, privacy, CLI/provider protocols, keyboard behavior, downloads, reader mode, desktop identity, and favicon policy.

Required local checks:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

For Linux packaging, use the configured Electron Builder targets and launch the packaged AppImage or unpacked app under a virtual display when no physical display is available. For Windows, build the local NSIS artifact on the Windows workspace and launch `release/win-unpacked/openstrawberry.exe`, confirm that the app stays alive, then request a normal window close and require clean process exit. Check that no BrowserWindow destruction error appears.

A Windows vault filesystem-mode assertion is conditional because POSIX permission bits are not represented the same way on Windows. The encrypted-vault and plaintext-leak assertions remain cross-platform.

## Current WIP message

The README and public repository should lead with a clear status block equivalent to:

> **Work in progress — do not download yet.** OpenStrawberry is an active development build. Public installers are not stable or signed. Wait for a verified release announcement before installing anything.

Keep platform download rows informational until signed releases exist. Do not link `releases/latest/download/...` assets while they would 404 or point to unsigned files.

## Recommended next work

First, finish the WIP documentation and replace all implicit Example Domain defaults with the neutral blank startup state. Then validate the local Windows build and synchronize it. Next, complete platform-native signing and release automation before enabling public download buttons or the updater channel.

After release hygiene, continue with permission-center UX, a production-grade profile/migration wizard, full native picture-in-picture windows, deeper browser fundamentals, and real approved agent execution. Every new agent capability should begin with a threat model, typed IPC contract, redaction tests, bounded execution policy, and user-visible approval state.

## Source documents

Read these before making architectural changes:

- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — trust boundaries and runtime ownership.
- [`docs/OPENSTRAWBERRY_PLAN.md`](OPENSTRAWBERRY_PLAN.md) — research-aligned product plan and Strawberry-to-OpenStrawberry behavior mapping.
- [`docs/SECURITY.md`](SECURITY.md) — security controls, residual risks, and disclosure path.
- [`docs/RELEASES.md`](RELEASES.md) — signed release policy and artifact rules.
- [`docs/UPDATES.md`](UPDATES.md) — in-app updater state machine and activation gate.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — contributor workflow and release restrictions.

When uncertain, preserve the local-first boundary, prefer explicit user approval, avoid secret exposure, and do not present work-in-progress artifacts as finished software.
