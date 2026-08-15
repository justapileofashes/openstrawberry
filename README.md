# OpenStrawberry

**OpenStrawberry** is a local-first desktop browser foundation for real Chromium browsing, secure profile handling, split-pane workspaces, a persistent Companion, and future multi-agent orchestration.

> This repository is an early native runtime foundation. It already contains an Electron desktop shell, real embedded Chromium tabs, durable split workspaces, an encrypted per-agent vault, approval-gated provider and selected local-CLI adapters, and a privacy-scoped first-launch migration flow. Production signing and several advanced browser capabilities remain planned milestones.

## Current capabilities

| Area | Included now |
|---|---|
| Native shell | Electron desktop application with hardened main/preload/renderer separation |
| Browser core | Create, select, close, navigate, back, forward, reload, stop, restore local tabs on launch, and retain pane-local browser state |
| Workspace | Two-pane split browsing with tab drag targets, pane-local navigation, and visible active-pane state |
| Workspace continuity | Named local snapshots save and restore a bounded set of tab URLs, split layout, and active pane; they do not clone site cookies, credentials, or page storage |
| Media deck | Detect compatible HTML video in the selected tab and expose play, pause, seek, mute, volume, and browser-native picture-in-picture commands |
| Agent control plane | Separate local agent profiles, per-agent encrypted credential bindings when operating-system encryption is available, local CLI discovery, and review-first handoff planning |
| Agent execution | Main-process-only OpenAI-compatible and Anthropic Messages provider calls, plus user-approved Codex, Claude Code, and OpenCode local runs; raw credentials are not exposed to the renderer |
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

Production installers require platform-specific signing and notarization credentials. See [`docs/INSTALLATION.md`](docs/INSTALLATION.md).

## Architecture and roadmap

The native main process owns browser views, sessions, permissions, native windows, future vault access, and agent execution. The renderer owns the browser chrome and agent workspace. Guest sites never receive Node.js access; the UI communicates with the main process through a narrow typed preload bridge.

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the runtime boundary and [`docs/OPENSTRAWBERRY_PLAN.md`](docs/OPENSTRAWBERRY_PLAN.md) for the research-aligned browser and agent roadmap.

## Status and scope

OpenStrawberry is intentionally building browser fundamentals before broad autonomy. It does **not** copy passwords, login sessions, cookies, payment data, browser history, or account tokens from another browser; password import must remain a separate user-selected export-file flow. It also does **not** yet execute Qwen Code or Kimi Code, provide fully automated multi-agent plan execution, bypass CAPTCHA/DRM, create a cross-site external video overlay when a site blocks native picture-in-picture, or include a production signed installer. Those features remain explicit, security-reviewed milestones.

## License

MIT. See [LICENSE](LICENSE).
