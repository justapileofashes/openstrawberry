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

- [x] `BrowserManager` owning real sandboxed `WebContentsView`s in the app-owned persistent partition.
- [x] Renderer-reported pane bounds; attach visible views and detach inactive ones.
- [x] Tabs: create, activate, close, editable address navigation, back, forward, reload, stop.
- [x] Titles, HTTPS-safe favicons, loading state, history state, audible state.
- [x] Navigation policy: HTTP(S) plus exactly `about:blank`; reject `file:`, `javascript:`, `data:`, and other schemes.
- [x] Enforce the policy on the guest itself via `will-navigate` and `will-redirect`, not only at the address bar.
- [x] First launch and every new tab open `about:blank`; typed navigation to `example.com` still works.
- [x] Session restore of bounded metadata only — never cookies, sessions, passkeys, payment data, passwords, or keys.
- [x] Tolerate a byte-order mark in the session file so an external editor cannot silently discard a session.
- [x] Destruction-safe teardown: release views at the window `close` lifecycle, idempotent, tolerant of a destroyed parent.
- [x] Validate: real pages render in both split panes, session restore works, and a normal window close exits cleanly with no main-process error dialog.
- [ ] Add unit coverage for attach/detach bookkeeping; teardown is currently proven by the launch-and-close smoke test only.

## M3 — Obsidian Relay chrome

- [x] Left tab rail showing favicons only, with a safe globe fallback, loading indicator, and audible marker.
- [x] Top-bar workspace controls, icon-first, with hover and keyboard-focus text bubbles.
- [x] Editable address bar that follows the focused tab unless the user is mid-edit.
- [x] Two-pane split browsing with drag-to-split tab targets and pane-local focus.
- [x] Visible focus states; active tab marked by a rail tick as well as tone, never colour alone.
- [x] Documentation for architecture, security, releases, and updates.
- [x] Lean the chrome into Liquid Glass: floating rail and top bar as rounded slabs over an ambient ground, multi-layer tint with specular rim, hover sheen on compact controls, inset address well, and fine grain.
- [x] Design the application icon and wire it into packaging and the development window.
- [x] Show the real page favicon in the tab rail, fetched in the main process and inlined as a data URL so the strict `img-src` policy holds.
- [x] Fall back to the conventional `/favicon.ico` path when a page declares no icon, and clear the mark on a cross-origin navigation.
- [x] Melt the favicon into a close cross on hover and focus, with a rebound easing and a swelling droplet behind it.
- [x] Light the chrome from a single ambient field behind the whole workspace rather than per-panel highlights, so the glass reveals what is behind it instead of owning its own shine.
- [x] Hold back the static tint and edge sweep so the travelling light is the dominant highlight rather than being swamped by fixed lighting.
- [x] Add an appearance settings panel on the top bar controlling shine on/off, intensity, colour, speed, and non-essential motion, persisted in renderer-owned storage.
- [ ] Icon-only Updates trigger; the Agent, Downloads, and Settings triggers are present but inert until their milestones land.
- [ ] Responsive behaviour below the minimum desktop width, and a full keyboard traversal pass.
- [ ] Bundle Inter and JetBrains Mono as local woff2 rather than relying on installed fonts. The renderer must not fetch webfonts from a remote host.

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

- [x] Generate the application icon: `resources/icon.svg` is the source, `pnpm icon` rasterises the 1024px master plus the seven Linux sizes, and electron-builder derives `.ico` and `.icns` from the master.
- [x] Configure macOS universal DMG, Windows x64 one-click per-user NSIS, and Linux AppImage, DEB, and RPM targets.
- [x] Register the app as its own desktop application: AppUserModelID matching the installed shortcut, `OpenStrawberry.exe` as the executable, a single-instance lock so one taskbar button is shared, and a Linux desktop entry with `StartupWMClass` and search keywords.
- [x] Handle a URL passed on the command line, handed to a running instance on relaunch, and via `open-url` on macOS.
- [x] Validate on Windows: built the NSIS artifact, launched the unpacked app, confirmed it stays alive, handed off a second launch, requested a normal close, and got a clean exit with no error dialog. The EXE was not installed.
- [ ] Register HTTP(S) scheme handlers so the app can be chosen as the default browser. Deferred until the link-handling path has been exercised end to end.
- [ ] Validate Linux AppImage, DEB, and RPM on a Linux runner.
- [ ] Validate the macOS DMG on a native macOS runner.

## M9 — Release readiness

Blocked: requires signing credentials that are not available in this environment.

- [ ] Windows Authenticode signing.
- [ ] macOS Developer ID signing and notarisation.
- [ ] Linux artifact verification.
- [ ] SHA-256 checksums and release provenance.
- [ ] Only then: enable download affordances and the update channel.
