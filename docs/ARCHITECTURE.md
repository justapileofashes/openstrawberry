# Architecture

## Runtime boundary

OpenStrawberry uses a local Electron desktop runtime. The main process is trusted and owns native Chromium `BrowserView` instances, profile/session partitions, downloads, permissions, migration, media windows, the future encrypted vault, and agent adapters. The React renderer is untrusted with secrets; it displays browser chrome and invokes a minimal typed capability surface exposed through the preload bridge.

| Layer | Owns | Must not own |
|---|---|---|
| Main process | Browser views, profiles, vault, native windows, local processes | Renderer presentation state |
| Preload | Typed browser/app bridge | Arbitrary Node APIs or unvalidated IPC |
| Renderer | Browser chrome, split layout, Companion UI, local state | Secrets, raw filesystem access, direct subprocess execution |
| Guest pages | Website rendering | Node integration, renderer DOM access, OpenStrawberry internals |

## Browser tab lifecycle

`BrowserManager` creates one sandboxed `BrowserView` per tab using an app-owned persistent session partition. The active view is attached within renderer-reported viewport bounds. Inactive views stay in memory but are detached from the window. Navigation, title, loading, media, history, downloads, and split-pane state are emitted to the renderer as `BrowserSnapshot` updates. A small local session record restores tabs, panes, active pane, and split state; it deliberately excludes cookies, passwords, and account tokens.

The current media deck executes user-triggered play, pause, seek, volume, mute, and browser-native picture-in-picture requests only against the selected tab’s exposed HTML video element. It reports an explicit unsupported state where a site, DRM layer, or embedded player does not expose compatible HTML media APIs. A future native external overlay must use an explicit per-site media capture policy rather than attempt to circumvent those restrictions.

## Planned Companion and orchestration model

The Companion uses explicit selected context. It shows a plan before dispatching work and can open visible Agent work tabs. The Orchestrator will dispatch scoped WorkItems to named specialists via a typed, run-scoped message bus. Every agent profile receives its own credential reference by default; raw values remain in a main-process vault and are never passed through the renderer, prompts, artifacts, or logs.

## Security baseline

The desktop shell enables context isolation, disables Node integration, sandboxes guest web pages, blocks arbitrary navigation schemes, denies permissions by default, and routes new-window requests into controlled browser tabs. Future milestones add permission UI, encrypted vault namespaces, redaction, browser profile isolation, policy gating, and agent audit trails.
