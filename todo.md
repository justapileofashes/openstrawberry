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
- [x] Bound every read of foreign bytes in the trusted process against the bytes as they arrive, not against a header the sender chose. A favicon body is capped mid-stream, because `content-length` is absent from any chunked response and any visited page can name an icon URL.
- [x] Write every store whole or not at all through one shared atomic write, so a crash or a full disk cannot leave a truncated credential file that reads as "no key was ever stored".
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

- [x] Downloads with per-item state and main-process-only reveal. The save path is chosen in the trusted process and never crosses IPC; the renderer is told a file name and a folder label, and `download:show-in-folder` takes an id, so a compromised renderer can only ask for one of its own downloads to be shown. Server-suggested names go through one sanitiser that flattens separators, strips control characters and bidi overrides, renames Windows device names, and refuses to create a hidden file.
- [x] Conservative, transparent tracker blocking with per-site exceptions. A short shipped list, never fetched or updated, so the blocker is not itself a third-party call on every launch. First-party requests are never blocked, which gives up CNAME-cloaked tracking deliberately rather than breaking pages. Counts are the whole interface: no blocked URL is recorded, reported, or persisted, because that list would be a browsing history.
- [x] Local text-only reader mode with no network or provider handoff. Reads the DOM the guest already loaded; nothing is fetched and nothing is summarised. This is the one place page content crosses into the trusted renderer, so a block carries a kind from a closed set and a plain string — no markup, URL, attribute, or style field exists for it to travel in — and the view renders every string as a React text node.
- [x] Media controls for compatible HTML video with browser-native picture-in-picture fallback. The renderer sends an action identifier from a closed set and the trusted process holds one fixed script per action, so no string the renderer supplies is ever evaluated in a page. Each action is something the user could already do with the page's own controls. State is read from a page that may be hostile, so it is bounded and re-derived, and an unreadable report means no controls rather than wrong ones.
- [x] Persistent tab groups with names, colours, and collapse state. Membership lives on the tab as a group id, so a tab is in at most one group by construction and closing one cannot leave a group referring to something gone. A colour is a token from a shipped palette, never a CSS value, so stored state can never reach a style attribute. Groups survive restart in the session file, which re-checks every membership against the groups that actually parsed. Collapsing hides members but never the active tab, and never closes or unloads anything.
- [x] Surface renaming and recolouring a group in the chrome. A groups panel lists every group with an inline name field, the palette as swatches rather than a free colour picker, a collapse toggle, and a dissolve that releases its tabs without closing them.
- [x] Named workspace snapshots. Addresses and labels only: no cookie, session, storage, or credential, and no type on the contract has a field one would fit in, so opening a workspace loads pages rather than restoring a signed-in state. The http(s) gate is applied on write and again on read, so a hand-edited file cannot introduce a scheme. Saving sends a name; the trusted process reads the open tabs itself.
- [x] Command palette and keyboard shortcuts. Ctrl/Cmd+K opens it; conventional browser bindings (new tab, close tab, reload, address bar, downloads, settings, back, forward) are bound as users already expect, and anything without a conventional chord is palette-only rather than given an invented one. The palette runs commands by id against capabilities the bridge already exposes, so it adds no IPC surface.

## M5 — Migration and privacy

- [x] Consent-first source browser, profile, and category selection. Detection is a fixed per-platform registry, read-only, and never opens a bookmark file.
- [x] Reviewable Chromium bookmark import and displayed default-search metadata — the provider's display name only, never its URL template, keyword, keys, or account state.
- [x] Firefox and Safari support through manual HTML bookmark exports only. `places.sqlite`, Safari's bookmark database, and every other internal browser file stay unopened.
- [x] Separately reviewed password CSV staging protected by OS encryption; no autofill, no sync, no raw reveal, unreachable by agents. Refuses to stage rather than falling back to plaintext, and the vault has no read path at all.
- [x] Never copy cookies, active sessions, account tokens, passkeys, payment data, extension binaries, or browser passwords. No migration type has a field one would fit in.
- [x] Renderer supplies no path, ever: a detected profile is an app-minted identifier, a picked file is an opaque handle, and the native dialog is opened by the trusted process.
- [x] Defensive parsers with size, depth, count, and length bounds; an http(s)-only scheme gate; skip-and-count for malformed records; warnings as codes with counts rather than free text that could carry user data.
- [x] Six-step review-first wizard with loading, empty, cancel, malformed-file, permission-denied, encrypted-storage-unavailable, and recoverable-error states, and a "Start fresh instead" escape on every screen.
- [x] Application-owned migration state, atomic commits, conservative same-address-and-folder deduplication, and Settings re-entry that says re-running can duplicate.
- [x] Privacy behaviour documented in `docs/MIGRATION_PRIVACY.md`.
- [x] Validate: `pnpm check`, `pnpm test` (548 tests), and `pnpm build` all pass.
- [ ] Exercise the wizard end to end in a running app against real Chrome, Firefox, and Safari exports on each platform. Covered by fixtures and unit tests today, not by a manual pass.
- [x] Surface imported bookmarks in the chrome. A searchable panel, reachable from the command palette. The search runs in the trusted process because the store holds up to fifty thousand entries and none of them needs to cross IPC to be filtered; what comes back is a bounded page and a total. Opening one goes through the ordinary tab path, so a stored address passes the same navigation policy a typed one does.
- [x] Apply the imported search provider name to address-bar search. The name selects from a table of templates OpenStrawberry ships; an imported string is never navigated to, interpolated into a URL, or stored as one. An engine with no shipped template falls back to the default rather than having a pattern guessed from its name, which would be the copy-the-template behaviour migration exists to refuse. Applied at launch and immediately on a commit that imported one.

## M6 — Agents and orchestration

- [x] Encrypted per-agent registry with profile metadata stored separately from credential values. `agent-credentials.enc` holds ciphertext; `agent-profile.json` and `agents.json` hold provider and model metadata and have no field a key would fit in. Per-agent keys are scoped and fall back to a shared one.
- [x] Refuse to store a credential when OS encryption is unavailable; never fall back to plaintext. A keyringless Linux session counts as unavailable however cheerfully `safeStorage` answers, and a key an earlier build wrote through that fallback is discarded at startup.
- [x] Agent Control Panel with name, role, executor, provider or CLI, model, optional HTTPS base URL, redacted credential status, and explicit remove/replace.
- [x] Provider presets: Anthropic, OpenAI, Google, OpenRouter, OmniRoute, Moonshot AI, Qwen, Ollama, and generic OpenAI-compatible.
- [x] Redaction tests proving no raw credential reaches renderer payloads, logs, snapshots, plans, artifacts, or error strings. A dedicated suite plants a canary key and searches every artefact the system produces: both snapshots, pushed state, both plain state files, the redacted error text, and the run log. Each assertion serialises a whole object, so a field added later that happens to carry a key fails without anyone remembering to extend the suite.
- [x] Scrub credential-shaped tokens out of task text at the IPC boundary, so a key pasted into the composer is never written to the run log. Anchored on issuer formats rather than entropy, because a task that silently loses part of itself is worse than one that keeps a key the user chose to paste.
- [ ] Local CLI adapters: Codex, Claude Code, Qwen Code, Kimi Code, OpenCode — allowlisted executables, restricted environment, bounded execution. The presets and the command validator exist; nothing spawns a process yet.
- [x] HTTP provider adapters for the Anthropic, OpenAI-compatible, and Ollama dialects. Request shaping lives in a module that never receives a credential; the trusted process adds the header immediately before sending. Redirects are refused rather than followed, because a following client would hand the key to whoever controls the redirect target. Bounded in time and in response size, cancellable from the run, and every failure is a code turned into wording the app holds — a provider's own error text is never shown or logged.
- [ ] Google and the remaining provider dialects. The presets exist; only three wire formats are implemented.
- [ ] Review-first typed orchestration graph with dependencies, bounded context grants, approval gates, budgets, artifacts, cancellation, and blocked/needs-user states. The run state machine, approval gates, and cancellation exist and are driven by a scripted loop; the graph does not.

## M7 — Updater

- [ ] Update panel states: disabled, checking, available, downloading, downloaded, error, install and restart.
- [ ] Gate activation on both a packaged build and verified release metadata; never download or install silently.

## M8 — Icons, packaging, CI

- [x] Generate the application icon: `resources/icon.svg` is the source, `pnpm icon` rasterises the 1024px master plus the seven Linux sizes, and electron-builder derives `.ico` and `.icns` from the master.
- [x] Configure macOS universal DMG, Windows x64 one-click per-user NSIS, and Linux AppImage, DEB, and RPM targets.
- [x] Register the app as its own desktop application: AppUserModelID matching the installed shortcut, `OpenStrawberry.exe` as the executable, a single-instance lock so one taskbar button is shared, and a Linux desktop entry with `StartupWMClass` and search keywords.
- [x] Handle a URL passed on the command line, handed to a running instance on relaunch, and via `open-url` on macOS.
- [x] Validate on Windows: built the NSIS artifact, launched the unpacked app, confirmed it stays alive, handed off a second launch, requested a normal close, and got a clean exit with no error dialog. The EXE was not installed.
- [x] Confirm the packaged renderer ships the production Content-Security-Policy and no source maps, so the built output is checked rather than the config that was meant to produce it.
- [ ] Register HTTP(S) scheme handlers so the app can be chosen as the default browser. Deferred until the link-handling path has been exercised end to end.
- [ ] Validate Linux AppImage, DEB, and RPM on a Linux runner.
- [ ] Validate the macOS DMG on a native macOS runner.

## M9 — Release readiness

The pipeline is complete and the gate is enforced by tooling. What remains is
signing credentials, which are not available in this environment and cannot be
produced here.

- [x] SHA-256 checksums and release provenance: `scripts/checksums.mjs` writes a `sha256sum -c` manifest and a `provenance.json` naming the commit, ref, and runner.
- [x] Refuse a release build that could only produce an undistributable artifact: `scripts/release-preflight.mjs` stops before the build and names the missing credential.
- [x] Verify what was actually produced rather than trusting the builder's exit code: `scripts/verify-artifacts.mjs` checks presence, real signature state, and checksum. It correctly fails the current unsigned local build.
- [x] Hardened-runtime entitlements for macOS notarisation, limited to the three a Chromium browser cannot run without.
- [x] Tag-driven release workflow building each platform on its own runner, re-verifying checksums after collection, and opening a draft release that never self-publishes.
- [ ] Windows Authenticode signing. Blocked: needs a certificate. Everything around it is in place — supply `CSC_LINK` and `CSC_KEY_PASSWORD`.
- [ ] macOS Developer ID signing and notarisation. Blocked: needs a certificate and an App Store Connect key.
- [ ] Linux artifact verification. Not blocked by credentials; needs a Linux runner, which the release workflow provides.
- [ ] Only then: enable download affordances and the update channel.
