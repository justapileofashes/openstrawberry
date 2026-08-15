# OpenStrawberry

[![Quality](https://github.com/justapileofashes/openstrawberry/actions/workflows/quality.yml/badge.svg)](https://github.com/justapileofashes/openstrawberry/actions/workflows/quality.yml)

**OpenStrawberry** is a local-first desktop browser foundation for real Chromium browsing, secure profile handling, split-pane workspaces, a persistent Companion, and future multi-agent orchestration.

> This repository is an early native runtime foundation. It already contains an Electron desktop shell, real embedded Chromium tabs, durable split workspaces, an encrypted per-agent vault, approval-gated provider and selected local-CLI adapters, and a privacy-scoped first-launch migration flow. Production signing and several advanced browser capabilities remain planned milestones.

## Download OpenStrawberry

> **No stable installer is available yet.** OpenStrawberry will publish signed platform installers only through [GitHub Releases](https://github.com/justapileofashes/openstrawberry/releases). Do not install binaries from forks, issue attachments, or unofficial mirrors. The current Linux DEB is a private smoke-test artifact and is intentionally not published as a user download.

When the first signed release is available, this section will offer separate macOS, Windows, and Linux installer buttons. Until then, the single release-status link below is deliberately non-downloadable and leads only to the repository’s release page.

[![Installer status: not released](https://img.shields.io/badge/Installer%20status-Not%20released-6b7280?style=for-the-badge&logo=github)](https://github.com/justapileofashes/openstrawberry/releases)

| Platform | Download from GitHub Releases | Expected installation |
|---|---|---|
| macOS | `OpenStrawberry-mac-universal.dmg` | Open the DMG and drag OpenStrawberry to Applications. |
| Windows | `OpenStrawberry-win-x64.exe` | Run the signed NSIS installer. |
| Linux | `OpenStrawberry-linux-x86_64.AppImage`, `.deb`, or `.rpm` | Use AppImage for portable launch, or install the package native to your distribution. |

Every stable release will include `SHA256SUMS.txt`, release notes, and platform-specific signing information. Follow the full verification and installation guidance in [`docs/RELEASES.md`](docs/RELEASES.md).

## Current capabilities

| Area | Included now |
|---|---|
| Native shell | Electron desktop application with hardened main/preload/renderer separation |
| Browser core | Create, select, close, navigate, back, forward, reload, stop, restore local tabs on launch, and retain pane-local browser state |
| Workspace | Two-pane split browsing with tab drag targets, pane-local navigation, and visible active-pane state |
| Workspace continuity | Named local snapshots save and restore a bounded set of tab URLs, split layout, and active pane; they do not clone site cookies, credentials, or page storage |
| Browser productivity | Keyboard-accessible command palette with actions for tabs, address focus, split workspace, saved workspaces, and the Companion; supports Ctrl on Windows/Linux and Command on macOS |
| Reader mode | Local text-only overlay for the selected tab, entered through the command palette; it extracts readable page text in-place and does not send it to a provider or third party |
| Media deck | Detect compatible HTML video in the selected tab and expose play, pause, seek, mute, volume, and browser-native picture-in-picture commands |
| Downloads | Session download panel with progress and completion state; completed files can be revealed through a main-process action without exposing local paths to the renderer |
| Agent control plane | Separate local agent profiles, per-agent encrypted credential bindings when operating-system encryption is available, local CLI discovery, and review-first handoff planning |
| Agent execution | Main-process-only OpenAI-compatible and Anthropic Messages provider calls, plus user-approved Codex, Claude Code, Qwen Code, Kimi Code, and OpenCode local runs; raw credentials are not exposed to the renderer |
| First launch | Detects requested browser families; allows a user-approved Chromium bookmark and displayed default-search-name import, or a fresh local profile |
| UI | OpenStrawberry dark Liquid Glass browser chrome and an Agents / Orchestrate / Runs control surface |
| Security baseline | Sandboxed guest pages, context isolation, disabled Node integration, explicit navigation scheme policy, and minimal IPC |
| Distribution configuration | Electron Builder targets for macOS DMG, Windows NSIS, Linux AppImage/DEB/RPM |

## Quick start

```bash
pnpm install
pnpm dev
```

The development shell opens a real Chromium tab using the app-owned default profile. Package a local test build with:

```bash
pnpm package:dir
```

Production installers require platform-specific signing and notarization credentials. See [`docs/INSTALLATION.md`](docs/INSTALLATION.md) and [`docs/RELEASES.md`](docs/RELEASES.md).

## Architecture and roadmap

The native main process owns browser views, sessions, permissions, native windows, future vault access, and agent execution. The renderer owns the browser chrome and agent workspace. Guest sites never receive Node.js access; the UI communicates with the main process through a narrow typed preload bridge.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the runtime boundary and [`docs/OPENSTRAWBERRY_PLAN.md`](docs/OPENSTRAWBERRY_PLAN.md) for the research-aligned browser and agent roadmap.

Read [`docs/SECURITY.md`](docs/SECURITY.md) for the enforced security controls, review evidence, residual risks, and responsible disclosure guidance.

Read [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md) for the current maintainer-continuity, signing-access, and recovery expectations.

## Get involved

OpenStrawberry is looking for contributors who care about local-first browser tooling, Electron security, Chromium workspace ergonomics, and carefully bounded agent execution. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md), review the current scope and limitations below, and open an issue before starting a large architectural change. Security concerns should follow the private reporting path in [`docs/SECURITY.md`](docs/SECURITY.md), not a public issue.

## Status and scope

OpenStrawberry is intentionally building browser fundamentals before broad autonomy. It does **not** copy passwords, login sessions, cookies, payment data, browser history, or account tokens from another browser; password import must remain a separate user-selected export-file flow. It also does **not** yet provide fully automated multi-agent plan execution, bypass CAPTCHA/DRM, create a cross-site external video overlay when a site blocks native picture-in-picture, or include a production signed installer. Those features remain explicit, security-reviewed milestones.

## License

MIT. See [LICENSE](LICENSE).
