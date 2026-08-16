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
- [x] Add explicit-approval Qwen Code and Kimi Code local runtime adapters with allowlisted executable names, restricted environments, bounded execution, and focused unit tests.

## First-launch migration and workspace continuity

- [x] Detect Chrome, Edge, Brave, Firefox, and Safari profile presence on supported platforms without reading protected data during discovery.
- [x] Add a first-launch browser-choice flow with user-approved Chromium bookmark and displayed default-search-name import into app-owned storage.
- [x] Add a dedicated password export-file import flow with a clear review screen and OS-encrypted local staging; never copy browser password databases, cookies, sessions, or account tokens.
- [ ] Add manual export-file imports for Firefox and Safari bookmarks/settings, plus a user-scoped history import policy.
- [x] Add a review-first manual HTML bookmark import for Firefox and Safari exports without reading `places.sqlite` or Safari’s `Bookmarks.plist`.
- [x] Add named workspace snapshots that restore bounded tab URLs, split layout, and active pane from local app-owned storage.
- [x] Add tab-group naming, colors, collapse behavior, and snapshot filtering.

## Browser productivity and control surfaces

- [x] Add a keyboard-accessible command palette for navigation, tab, split, workspace, and Companion actions.
- [x] Add keyboard shortcuts for address focus, tabs, split workspace, and command palette.
- [x] Add a visible download manager with per-item state and main-process-only local reveal actions.
- [x] Add a local text-only reader mode for the selected browser tab with no network or provider handoff.
- [x] Add an explicitly configured tracker/ad blocking policy with transparent per-site controls.
- [ ] Add a permissions and agent-vault center with auditable local settings.

## Browser-first desktop renderer refinement

 - [x] Port the approved favicon-only left tab rail, top-bar workspace controls, hover/focus tooltips, always-on Motion and Liquid Glass, simplified search control, and cohesive glassmorphism to the Electron renderer.
 - [x] Validate the Electron renderer update in source and an unpacked native package so configured future installers include the revised interface.

## Desktop updates and Agent Control Panel

 - [x] Add a signed-release-only in-app update state machine with user-visible availability, download progress, install/restart action, and safe disabled behavior before a stable update feed exists.
 - [x] Configure the in-app updater for OpenStrawberry’s signed public GitHub Releases feed; keep it disabled until the required signed release metadata is available.
 - [x] Add a top-bar Agent Control Panel for creating agents and selecting a provider, model, and local CLI or API-backed runtime without exposing credentials to the renderer.
 - [x] Add focused tests and package validation for the update bridge and Agent Control Panel integration.
 - [x] Convert the labeled top-bar Agent rail and Updates triggers to icon-only glass controls while retaining accessible hover and keyboard-focus tooltips.
 - [x] Run clean application startup and native installer/package smoke checks in the available Linux environment, documenting platform-specific validation still required elsewhere.
 - [x] Synchronize the verified OpenStrawberry repository to the user-provided local `D:\docs\claudecodeprojects\openstrawberry` folder and retain it as a target for future requested app changes.
 - [x] Make the credential-vault filesystem permission assertion portable across Linux and Windows local development environments.
 - [x] Build a local Windows NSIS installer executable and place it in the user’s local OpenStrawberry workspace without committing the binary to Git.
 - [x] Prevent BrowserWindow-destruction errors during Windows app shutdown by making BrowserView teardown destruction-safe.
 - [x] Remove the default File, Edit, View, and Window application menu from the Windows desktop app.
 - [x] Rebuild and smoke-test the corrected local Windows NSIS installer executable.

## Release validation

- [x] Validate an unpacked Linux Electron application and native DEB package build from the configured Electron Builder targets.
- [x] Validate unsigned Linux AppImage, DEB, and RPM artifact generation on a network-capable Linux runner; inspect DEB/RPM metadata and generate checksums locally without publishing the artifacts.
- [x] Replace Electron’s default Linux package icon with the OpenStrawberry PNG application icon.
- [x] Add native macOS ICNS and Windows ICO conversions of the OpenStrawberry application icon.
- [ ] Validate AppImage/RPM/macOS DMG/Windows NSIS artifacts on appropriate release runners.
- [ ] Configure platform signing, macOS notarization, checksums, and release publishing; do not publish unsigned binaries.
- [x] Add a GitHub Releases-first installer discovery path with clear platform download guidance and signed-release verification steps; no unsigned binary is presented as a public download.
- [x] Add a local release-artifact checksum verification tool that writes `SHA256SUMS.txt` for eligible installer assets.
- [ ] Add a reproducible release process that uploads signed macOS, Windows, and Linux installers with SHA-256 checksums and release notes.
- [x] Configure the stable native app identity, Windows Start/desktop shortcut behavior, and Linux searchable desktop entry; validate the Linux DEB desktop registration.
- [x] Document one-time graphical installation and post-install launch/pinning steps for macOS, Windows, and Linux.
- [x] Add macOS, Windows, and Linux GitHub Release download buttons that resolve to the correct signed installer assets when a stable release is available.

## Release-readiness remediation

- [x] Remove or disable OS-specific installer-asset links until a real signed GitHub Release exists, and place an explicit no-stable-release banner before any download affordance.
- [x] Add focused automated coverage for main-process behavior, including IPC sender/payload gates, vault persistence, provider execution, and CLI execution boundaries; permission denial remains enforced by main-process configuration.
- [x] Replace floating `latest` dependency ranges with reviewed versions that match the lockfile and support reproducible installs.
- [x] Replace the remaining Vitest caret range with the reviewed exact lockfile version and re-run frozen-install validation.
- [x] Add a GitHub Actions quality workflow for install, type checking, unit tests, and production builds on pushes and pull requests; first published run passed.
- [x] Document maintainer recovery, release access, and a contributor path that reduces the current single-maintainer risk.
- [x] Validate network-capable Linux installers plus unsigned Windows x64 and macOS x64 directory-package prerequisites; retain macOS universal/DMG, Windows NSIS, signing, notarization, and public installer release as explicit pending work.
- [x] Reconcile the release-readiness review against the current ready-to-push branch and explicitly report the remaining workflow authorization and platform-signing prerequisites.

## Security hardening review

- [x] Audit Electron window, BrowserView, preload, IPC, navigation, and permission boundaries against the current security checklist.
- [x] Add validation and tests for every renderer-reachable IPC request, including malformed payloads and untrusted navigation input.
- [x] Review credential encryption, provider/CLI approval gates, prompt/context handling, process timeouts, and local CLI workspace containment.
- [x] Tighten migration parsers, local persistence permissions, release artifact exclusions, and dependency/package configuration.
- [x] Document threat boundaries, residual risks, and required signing/release controls; publish only verified hardening changes.

## Repository promotion

- [x] Audit the public GitHub profile, topic discoverability, onboarding, and contribution path.
- [x] Add accurate community and contributor materials that improve repository trust and participation.
- [x] Prepare factual launch copy for GitHub, Hacker News, Reddit, and developer social channels.
- [ ] Obtain explicit user authorization before posting or submitting content to any third-party community.
- [ ] Verify account access and current posting rules for Hacker News, Reddit r/electronjs, Reddit r/opensource, and the connected developer-social account.
- [ ] Tailor and review final destination-specific launch posts without overstating OpenStrawberry’s current release or security posture.
- [ ] Obtain final per-post confirmation immediately before submitting public content.
- [ ] Record authorized publication outcomes privately outside the repository.
- [x] Submit the authorized r/electronjs post; record its public link and immediate Reddit filter removal without reposting.
- [x] Remove the requested launch documentation and related references from the public repository.
- [x] Validate and publish the repository cleanup.
 - [x] Requested launch-documentation cleanup completed and validated.

> Note: The unchecked items above track the requested cleanup and validation; the final checked history entry records that the request has been received.

## WIP repository and Claude Code handoff

- [x] Mark the public GitHub repository and README as work in progress with a prominent do-not-download-yet warning and no misleading release-download prompts.
- [x] Replace the first-launch Example Domain placeholder with a safe OpenStrawberry start page or neutral blank browser state, without removing intentional user-entered navigation to example.com.
- [x] Create a comprehensive Claude Code handoff covering the project architecture, security model, design system, inspirations, implementation status, testing, packaging, and next steps.
- [x] Create a copy-ready Claude Code rebuild prompt that instructs a new coding agent how to reproduce and continue the complete OpenStrawberry project.
- [x] Recover the interrupted local workspace by restoring deleted tracked source files without deleting or overwriting untracked local files.
- [ ] Synchronize the WIP messaging, launch-default fix, and Claude Code handoff into the user-provided local workspace.
- [ ] Validate the updated repository and local workspace before publishing the final changes.

## End of current task checklist
