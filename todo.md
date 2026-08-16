# OpenStrawberry build checklist

Each milestone is complete only after
`pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build`
passes. Planned work is never marked done.

## M0 — Scaffold

- [x] Pin pnpm, strict TypeScript, Vite, React 19, Electron 43, Vitest, and electron-builder to exact reviewed versions.
- [x] Split `tsconfig.main.json` and `tsconfig.renderer.json`; author the preload as `.cts` so it compiles to CommonJS `.cjs`.
- [x] Ship a strict production Content-Security-Policy, relaxing it only for the Vite dev server.
- [x] Establish the Obsidian Relay token foundation in `src/renderer/styles.css`.
- [x] Add the work-in-progress README, licence, and this checklist.
- [x] Add the CI quality workflow (frozen install, type check, tests, production build).
- [x] Pin the Electron binary download explicitly: Electron 43 ships no postinstall hook, so `install-electron` runs from the project `postinstall`.
- [x] Validate: window opens, renders the glass shell, and exits cleanly on a normal window close with no main-process error.

## M1 — Trust boundary

- [x] Runtime validators for every renderer-reachable IPC payload, with no coercion, bounded lengths, and prototype-pollution rejection.
- [x] Sender verification tying each channel to the trusted renderer's WebContents and top-level frame.
- [x] Route every channel through one router that verifies sender, validates payload, then redacts failures; no per-channel opt-out.
- [x] Redact main-process errors so local paths, credentials, and stack frames never reach the renderer.
- [x] Narrow typed preload bridge; no generic `invoke`, no renderer-controlled channel, no Node, filesystem, or shell access.
- [x] Keep the preload self-contained: a sandboxed preload may only require `electron`, so shared contracts are type-only and channel names are compile-time pinned.
- [x] Tests for malformed payloads, untrusted senders, subframe senders, remote origins, and error redaction.
- [x] Validate: the renderer reads shell state over the hardened channel in a running app.

## M2 — Real browsing

- [ ] `BrowserManager` owning real sandboxed `WebContentsView`s in the app-owned persistent partition.
- [ ] Renderer-reported pane bounds; attach visible views and detach inactive ones.
- [ ] Tabs: create, activate, close, editable address navigation, back, forward, reload, stop.
- [ ] Titles, HTTPS-safe favicons, loading state, history state, audible state.
- [ ] Navigation policy: HTTP(S) plus exactly `about:blank`; reject `file:`, `javascript:`, `data:`, and other schemes.
- [ ] First launch and every new tab open `about:blank`; typed navigation to `example.com` still works.
- [ ] Session restore of bounded metadata only — never cookies, sessions, passkeys, payment data, passwords, or keys.
- [ ] Destruction-safe teardown: release views at the window `close` lifecycle, idempotent, tolerant of a destroyed parent.
- [ ] Validate: a normal window close exits cleanly with no main-process error dialog.

## M3 — Obsidian Relay chrome

- [ ] Left tab rail showing favicons only, with a safe globe fallback and loading indicator.
- [ ] Top-bar workspace controls, icon-first, with hover and keyboard-focus text bubbles.
- [ ] Icon-only Agent rail and Updates triggers, with accessible names retained.
- [ ] Editable address bar.
- [ ] Two-pane split browsing with drag-to-split tab targets and pane-local focus.
- [ ] Responsive desktop chrome, full keyboard reachability, visible focus states.
- [ ] Bundle Inter and JetBrains Mono as local woff2 rather than relying on installed fonts.

## M4 — Browser fundamentals

- [ ] Downloads with per-item state and main-process-only reveal.
- [ ] Conservative, transparent tracker blocking with per-site exceptions.
- [ ] Local text-only reader mode with no network or provider handoff.
- [ ] Media controls for compatible HTML video with browser-native picture-in-picture fallback.
- [ ] Persistent tab groups with names, colours, and collapse state.
- [ ] Named workspace snapshots.
- [ ] Command palette and keyboard shortcuts.

## M5 — Migration and privacy

- [ ] Consent-first source browser, profile, and category selection.
- [ ] Reviewable Chromium bookmark import and displayed default-search metadata.
- [ ] Firefox and Safari support through manual HTML bookmark exports only.
- [ ] Separately reviewed password CSV staging protected by OS encryption; no autofill, no sync, no raw reveal, unreachable by agents.
- [ ] Never copy cookies, active sessions, account tokens, passkeys, payment data, extension binaries, or browser passwords.

## M6 — Agents and orchestration

- [ ] Encrypted per-agent registry with profile metadata stored separately from credential values.
- [ ] Refuse to store a credential when OS encryption is unavailable; never fall back to plaintext.
- [ ] Agent Control Panel with name, role, executor, provider or CLI, model, optional HTTPS base URL, redacted credential status, and explicit remove/replace.
- [ ] Provider presets: OpenAI, Anthropic, OpenRouter, Moonshot AI, Qwen, OmniRoute, and generic OpenAI-compatible.
- [ ] Local CLI adapters: Codex, Claude Code, Qwen Code, Kimi Code, OpenCode — allowlisted executables, restricted environment, bounded execution.
- [ ] Review-first typed orchestration graph with dependencies, bounded context grants, approval gates, budgets, artifacts, cancellation, and blocked/needs-user states.
- [ ] Redaction tests proving no raw credential reaches renderer payloads, logs, snapshots, plans, artifacts, or error strings.

## M7 — Updater

- [ ] Update panel states: disabled, checking, available, downloading, downloaded, error, install and restart.
- [ ] Gate activation on both a packaged build and verified release metadata; never download or install silently.

## M8 — Icons, packaging, CI

- [ ] Generate native macOS, Windows, and Linux icon assets.
- [ ] Configure macOS universal DMG, Windows x64 one-click per-user NSIS, and Linux AppImage, DEB, and RPM targets.
- [ ] Validate on Windows: build the NSIS artifact, launch the unpacked app, confirm it stays alive, request a normal close, and require a clean exit. Do not silently install the EXE.
- [ ] Validate Linux AppImage, DEB, and RPM on a Linux runner.
- [ ] Validate the macOS DMG on a native macOS runner.

## M9 — Release readiness

Blocked: requires signing credentials that are not available in this environment.

- [ ] Windows Authenticode signing.
- [ ] macOS Developer ID signing and notarisation.
- [ ] Linux artifact verification.
- [ ] SHA-256 checksums and release provenance.
- [ ] Only then: enable download affordances and the update channel.
