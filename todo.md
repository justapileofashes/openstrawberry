# OpenStrawberry desktop build checklist

- [x] Create the public `openstrawberry` GitHub repository and establish protected project documentation.
- [x] Scaffold the Electron, TypeScript, and React desktop runtime with secure main/preload/renderer boundaries.
- [x] Implement the first real browser primitives: profile storage, tabs, navigation lifecycle, and native Chromium views.
- [x] Port the OpenStrawberry visual shell and agent workspace foundations into the desktop renderer.
- [x] Add architecture stubs for the vault, Companion, Orchestrator, agent registry, and installer/update configuration.
- [ ] Run static checks and build/package smoke tests, then publish source and documentation to GitHub.

## Browser-core milestone

- [x] Add durable local tab history and restore the previous window session at launch.
- [x] Add a real multi-pane split workspace with drag-targeted tab placement and pane-local navigation.
- [x] Implement a secure permissions and downloads baseline for app-owned browser profiles.
- [x] Add native picture-in-picture window scaffolding with truthful media capability detection.
- [ ] Test the browser core, package a Linux installer artifact, and publish the milestone to GitHub.

## Companion and orchestration control plane

- [x] Add a local encrypted per-agent credential registry and local coding-CLI detection.
- [x] Add a visible review-first multi-agent orchestration plan with scoped handoff steps.
- [x] Add an audited provider execution adapter with main-process credential use, HTTPS-only calls, bounded requests, native approval, and redacted renderer results.
- [x] Add audited explicit-approval local execution adapters for Codex, Claude Code, and OpenCode; keep Qwen Code and Kimi Code detection-only pending additional protocol verification.

## First-launch migration and workspace continuity

- [x] Detect Chrome, Edge, Brave, Firefox, and Safari profile presence on supported platforms without reading protected data during discovery.
- [x] Add a first-launch browser-choice flow with user-approved Chromium bookmark and displayed default-search-name import into app-owned storage.
- [ ] Add a dedicated password export-file import flow with a clear review screen; never copy browser password databases, cookies, sessions, or account tokens.
- [ ] Add manual export-file imports for Firefox and Safari bookmarks/settings, plus a user-scoped history import policy.
- [ ] Add named workspace snapshots and tab groups.
