# Claude Code Prompt — Build OpenStrawberry From Scratch

Copy everything below the divider into a new Claude Code session. The prompt assumes **there is no existing implementation to continue**. It is a complete build specification for recreating the project from an empty directory.

---

You are the principal engineer and design engineer for a new open-source desktop browser named **OpenStrawberry**. Build the product **from scratch** in this repository. Do not assume any pre-existing files, architecture, components, tests, or installer configuration exist. Begin by inspecting the directory and any `AGENTS.md` instructions. Then create a clear implementation plan, maintain a root `todo.md`, and execute the work in small tested milestones.

# 1. Product mission

OpenStrawberry is a **local-first, cross-platform desktop browser** for macOS, Windows, and Linux. It is not a hosted website, mock browser, generic dashboard, or a code-agent wrapper. It must be a real browser application that users install normally, search by name, pin to a taskbar or dock, and use without terminal commands after installation.

The browser should be inspired by the **publicly observable workflow patterns** of Strawberry Browser’s Companions: browser-native assistance, explicit selected context, planning before action, visible specialist delegation, review before side effects, persistent artifacts, and local-first privacy. Do not claim access to or reproduce proprietary Strawberry internals. Implement original, transparent equivalents.

The product name is **OpenStrawberry**. Use the stable desktop identity `io.openstrawberry.browser`.

The public project is initially **work in progress**. The README and repository description must lead with:

> **WORK IN PROGRESS — DO NOT DOWNLOAD YET.** OpenStrawberry is an active development build. Public installers are not stable or signed. Wait for a verified release announcement before installing anything.

Do not publish, advertise, or link to unsigned installers as stable downloads. Document the intended release formats, but keep actual download buttons disabled until signed release artifacts exist.

# 2. Technology choices

Build one desktop codebase with these technologies:

| Concern | Required choice |
|---|---|
| Desktop runtime | Electron with the Chromium engine |
| Language | TypeScript with strict type checking |
| UI | React and Vite |
| Package manager | pnpm with an exact, frozen lockfile |
| Browser content | Real Electron `BrowserView` instances, not HTML mock panes |
| Test runner | Vitest |
| Packaging | electron-builder |
| Mac installer | Universal DMG |
| Windows installer | x64 NSIS one-click, per-user installer |
| Linux packages | AppImage, DEB, and RPM |

Use a clean Electron main/preload/renderer separation. Set `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true` for renderer and guest browser content. Compile the packaged preload as CommonJS (`.cjs`) so Electron’s sandboxed preload can load correctly in packaged builds.

# 3. Design system: Obsidian Relay

The visual direction is **Obsidian Relay**. The user requested a monochrome, highly polished, motion-forward, Liquid Glass system informed by contemporary Refero-style product design and modern browser workspaces. The product must feel crafted, dark, calm, and precise rather than like a generic admin interface.

Use these design rules:

1. Make the browser chrome near-black with crisp white and gray type hierarchy.
2. Use selective, layered monochrome Liquid Glass on browser controls, compact toolbars, the tab rail, address surface, Agent rail, update panel, approval panels, and settings surfaces.
3. Keep webpage content readable and content-first. Do not place an opaque designer layer over arbitrary websites.
4. Put the tab rail on the **left**. Tabs are favicon-only icons with a safe globe fallback and loading indicator.
5. Put workspace controls on the **top bar**, not in the left rail.
6. Use icon-only compact controls whenever possible. Show concise text bubbles on hover and keyboard focus for accessibility and discoverability.
7. The top-bar Agent rail control and Updates control must be icon-only. Do not show persistent labels on those controls.
8. Motion and Liquid Glass are always part of the visual system. Do not add user-facing Motion or Glass toggles.
9. Use short, interruptible transform/opacity transitions with strong easing. Respect `prefers-reduced-motion` for non-essential animation.
10. Keep visible focus rings, keyboard navigation, readable contrast, and responsive layouts at a minimum desktop width.
11. On Windows, remove the default Electron File/Edit/View/Window application menu while preserving the normal native minimize, maximize/restore, and close buttons.

# 4. Security and trust boundaries

Use this architecture exactly. Keep these responsibilities separate.

| Layer | Owns | Must never own |
|---|---|---|
| Main process | BrowserViews, profile/session partitions, downloads, migration, agent credential vault, provider HTTP calls, local CLI processes, updater, native windows | Renderer presentation state |
| Preload | A minimal typed API bridge | Arbitrary Node APIs, filesystem access, shell access, unvalidated IPC |
| React renderer | Browser chrome, tabs, panes, Agent rail, settings, update UX | Raw credentials, direct subprocesses, local filesystem access |
| Guest BrowserViews | Real website rendering | Node integration, OpenStrawberry DOM access, arbitrary app APIs |
| Shared contracts | IPC validators, browser snapshots, protocol types, navigation policy | UI-only mutable state |

All renderer-reachable IPC must validate both the trusted sender and every payload at runtime. Keep raw API keys, browser passwords, session tokens, and filesystem paths out of the renderer, browser snapshots, orchestration plans, logs, errors, artifacts, and tests.

Use Electron `safeStorage` for encrypted credential values. Persist agent profile metadata separately from encrypted agent credential data. If operating-system encryption is unavailable, refuse to store the credential rather than falling back to plaintext.

Guest tabs must be sandboxed. Deny permission requests by default. Do not permit arbitrary schemes; allow only HTTP(S) browser navigation plus the exact internal neutral page `about:blank`. Reject `file:`, `javascript:`, `data:`, and other unsafe user-entered schemes.

# 5. Real browser requirements

Create a `BrowserManager` in the main process. Every tab must be a real sandboxed `BrowserView` inside an app-owned persistent session partition. The renderer reports viewport bounds; the main process attaches the active BrowserViews to the BrowserWindow and detaches inactive ones.

Implement the following browser features:

- Create, activate, close, and navigate tabs.
- Address bar with URL normalization and search fallback.
- Empty address and first launch must open `about:blank`, **never `https://example.com`**.
- Explicit user navigation to `https://example.com` must remain allowed; only implicit placeholder startup behavior is forbidden.
- Back, forward, reload, and stop.
- Loading, title, favicon, audible/media, history availability, and active-pane state.
- Favicon-only left tab rail with an HTTPS-only favicon policy and safe globe fallback.
- Split screen with two panes in the first milestone, tab assignment to panes, drag targets, and pane-local focus.
- Persistent named tab groups with color, collapse state, and workspace snapshots.
- Session restore that preserves bounded tab URLs, tab IDs, pane layout, split state, privacy preferences, and groups.
- Session persistence must never copy cookies, account sessions, passkeys, payment information, raw browser passwords, or API keys.
- Download state with a renderer-safe completion/reveal action owned by the main process.
- Conservative tracker blocking with transparent counters and per-site exceptions. Do not claim comprehensive ad blocking.
- Reader mode and keyboard shortcuts as local browser capabilities.
- Media controls for compatible HTML video plus honest browser-native picture-in-picture fallback. Do not bypass DRM or website restrictions.

Make BrowserView cleanup destruction-safe. On window shutdown, clean up BrowserViews during the BrowserWindow `close` lifecycle before the window is destroyed. BrowserView detachment must tolerate an already-destroyed parent window, be idempotent, and never throw `Object has been destroyed` during normal close. Test a packaged Windows build by launching it, requesting a normal close, and requiring a clean exit.

# 6. First-launch migration and local privacy

Implement a consent-first migration flow. It should detect suitable local browser sources but make the user explicitly select a browser, profile, and import categories. Support:

- Reviewable Chromium bookmarks and displayed default-search-name import.
- Manual Firefox and Safari HTML bookmark imports only. Do not read Firefox `places.sqlite` or Safari bookmark databases directly.
- A separate reviewed password CSV staging flow encrypted with OS-backed storage.
- A fresh local profile option.

Never automatically migrate cookies, active login sessions, account tokens, passkeys, payment data, browser passwords, or extension binaries. Password staging must not autofill, sync, reveal existing raw values, or expose passwords to agents.

# 7. Agents, providers, local coding CLIs, and orchestration

The product has browser-native **Companions**, not just a model picker. The primary Agent rail should work with explicitly selected tab, pane, workspace, file, and artifact context. The user must be able to see, edit, revoke, and approve context before meaningful agent work begins.

Build a review-first Orchestrator. It creates a typed task graph for roles such as Researcher, Coder, and Reviewer. It must expose dependencies, assigned context, intended artifacts, budgets, approval points, status, cancellation, and blocked/needs-user states. Do not hide multi-agent work behind opaque chat messages.

Add a top-bar **Agent Control Panel**. It must let users create and edit agents with:

- Name and role.
- Executor type: provider API or supported local coding CLI.
- Provider preset, model ID, optional HTTPS base URL, and separate per-agent credential.
- A redacted credential status and an explicit remove/replace flow.

Provider presets must include OpenAI, Anthropic, OpenRouter, Moonshot AI, Qwen, OmniRoute, and generic OpenAI-compatible endpoints. Support local coding CLI adapters for Codex, Claude Code, Qwen Code, Kimi Code, and OpenCode.

Provider calls and CLI execution must stay in the main process. Local CLIs must be allowlisted, run with a restricted environment, have bounded inputs and execution policy, and never inherit arbitrary secrets. The renderer must never choose an arbitrary executable path or shell command.

# 8. Updates and release plan

Implement an in-app update panel and main-process update manager using `electron-updater` with GitHub Releases as the intended provider. It must show disabled, checking, available, downloading, downloaded, error, and explicit install/restart states.

Keep the update channel **disabled** until the project has a signed stable release and verified update metadata. Do not silently download or install updates. When enabled later, users should explicitly download, then choose restart-and-install instead of manually redownloading an installer.

Configure stable artifact names:

| Platform | Planned artifact |
|---|---|
| macOS | `OpenStrawberry-mac-universal.dmg` |
| Windows | `OpenStrawberry-win-x64.exe` |
| Linux | `OpenStrawberry-linux-x86_64.AppImage` |
| Linux | `OpenStrawberry-linux-amd64.deb` |
| Linux | `OpenStrawberry-linux-x86_64.rpm` |

Use one-click per-user Windows NSIS. Keep `allowToChangeInstallationDirectory` disabled because it is incompatible with one-click NSIS configuration. Do not claim signed releases until Authenticode signing, macOS Developer ID/notarization, Linux artifact verification, SHA-256 checksums, and release provenance are actually complete.

# 9. Suggested file structure

Create an intentional, testable file layout resembling this:

```text
src/
  main/
    index.ts
    browser-manager.ts
    agent-registry.ts
    provider-runner.ts
    cli-runner.ts
    orchestrator.ts
    migration-manager.ts
    update-manager.ts
    ipc-security.ts
  preload/
    index.cts
  renderer/
    App.tsx
    styles.css
    browser-chrome.ts
    global.d.ts
  shared/
    browser.ts
    navigation.ts
    ipc-validation.ts
    agent.ts
    agent-run.ts
    provider-protocol.ts
    cli-protocol.ts
    privacy.ts
    migration.ts
    update.ts
    desktop-shell.ts
docs/
  ARCHITECTURE.md
  SECURITY.md
  RELEASES.md
  UPDATES.md
  OPENSTRAWBERRY_PLAN.md
  CLAUDE_CODE_HANDOFF.md
todo.md
package.json
```

Use narrow modules with focused unit tests adjacent to security-sensitive logic. Write maintainable documentation for architecture, privacy/migration, release status, updater activation, and contributor workflow.

# 10. Build order

Work in these phases and update `todo.md` as each item is verified:

1. Scaffold Electron, Vite, React, TypeScript, pnpm, strict checking, Vitest, and electron-builder.
2. Build the hardened main/preload/renderer boundary and test IPC sender/payload validation.
3. Implement real BrowserViews, address normalization, `about:blank` first launch, tabs, navigation, session restore, and lifecycle-safe cleanup.
4. Add the Obsidian Relay browser chrome: left favicon rail, top workspace controls, glass tooltips, split panes, and responsive behavior.
5. Add downloads, tracker policy, media controls, reader mode, tab groups, and workspaces.
6. Add consent-first migration and separate encrypted password staging.
7. Add the agent registry, encrypted per-agent vault, Agent Control Panel, provider adapters, local CLI adapters, and review-first orchestration plans.
8. Add the guarded GitHub Releases updater UI and state machine, still disabled without signed release metadata.
9. Configure native icons and packaging for all target platforms.
10. Add CI that runs frozen install, type checking, tests, and production build on pull requests and pushes.
11. Add release signing, notarization, checksums, and public release automation only when credentials and native runners are available.

# 11. Testing and acceptance criteria

Create tests for shared navigation rules, IPC validation, trusted renderer checks, BrowserView lifecycle helpers, agent vault encryption/redaction, provider protocol validation, CLI invocation restrictions, migration parsers, orchestration graph validation, updater state transitions, favicon safety, tab/workspace behavior, and privacy policy behavior.

Use this basic validation loop:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

For Windows package validation, build the NSIS installer and unpacked app. Launch the unpacked executable, verify it remains running, request a normal window close, and verify clean exit without a main-process error dialog. Do not silently install the EXE merely to test it.

For Linux, build and validate AppImage, DEB, and RPM artifacts. For macOS, validate on a native macOS release runner before claiming DMG readiness. Never place large generated installer assets in Git.

# 12. Anti-requirements

Do not build a fake browser UI. Do not turn the product into a SaaS dashboard or generic chat application. Do not use arbitrary webview access, enable Node in guest pages, expose arbitrary IPC, execute arbitrary shell commands, place secrets in the renderer, log credentials, bypass CAPTCHA/DRM, claim complete ad blocking, copy cookies/sessions, or publish unsigned binaries as stable downloads.

At every milestone, preserve the local-first security model, make agent actions reviewable, add focused tests, keep the README honest about work-in-progress status, and distinguish implemented behavior from planned milestones.

---

End of from-scratch OpenStrawberry build prompt.
