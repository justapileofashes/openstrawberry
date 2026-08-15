# OpenStrawberry

**OpenStrawberry** is a local-first desktop browser foundation for real Chromium browsing, secure profile handling, split-pane workspaces, a persistent Companion, and future multi-agent orchestration.

> This repository is an early native runtime foundation. It already contains an Electron desktop shell, a real embedded Chromium tab lifecycle, navigation controls, typed renderer-to-main IPC, a Liquid Glass browser UI, and the initial Companion/Orchestrator UI foundation. Migration, picture-in-picture, the encrypted vault, real agent adapters, and production signing remain planned milestones.

## Current capabilities

| Area | Included now |
|---|---|
| Native shell | Electron desktop application with hardened main/preload/renderer separation |
| Browser core | Create, select, close, navigate, back, forward, reload, stop, restore local tabs on launch, and retain pane-local browser state |
| Workspace | Two-pane split browsing with tab drag targets, pane-local navigation, and visible active-pane state |
| Media deck | Detect compatible HTML video in the selected tab and expose play, pause, seek, mute, volume, and browser-native picture-in-picture commands |
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

OpenStrawberry is intentionally building browser fundamentals before autonomous agents. It does **not** yet import passwords, copy login sessions, run coding agents, bypass CAPTCHA/DRM, create a cross-site external video overlay when a site blocks native picture-in-picture, or include a production signed installer. Those features are tracked as explicit, security-reviewed milestones.

## License

MIT. See [LICENSE](LICENSE).
