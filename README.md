# OpenStrawberry

> **WORK IN PROGRESS — DO NOT DOWNLOAD YET.** OpenStrawberry is an active
> development build. Public installers are not stable or signed. Wait for a
> verified release announcement before installing anything.

A local-first, open-source desktop browser with browser-native AI Companions,
review-first multi-agent orchestration, per-agent encrypted credentials, and
privacy-aware migration. Real Chromium browsing, not a mockup.

## Status

There is **no stable release**, and there are **no public downloads**. The
in-app update channel is disabled and stays disabled until signed artifacts and
verified update metadata exist. Nothing in this repository should be treated as
production software.

| Area | State |
|---|---|
| Desktop shell (Electron, hardened main/preload/renderer split) | Built |
| Real Chromium browsing, tabs, split panes | Built |
| Obsidian Relay chrome | Built; responsive and full keyboard traversal outstanding |
| Migration and encrypted password staging | Built; not yet exercised end to end against real exports on every platform |
| Agent panel and encrypted per-agent credential store | Built |
| Providers, local CLI adapters, orchestration | Not implemented. The run loop is a scripted stand-in that calls no provider and starts no process |
| Browser fundamentals (downloads, tracker blocking, reader mode, tab groups) | Not implemented |
| Updater | Not implemented, disabled by design |
| Signed releases | Pipeline complete and enforced by tooling; blocked on signing credentials |

See [`todo.md`](todo.md) for the working checklist.

## Principles

- **Local-first.** Browsing data, credentials, and agent state stay on the
  machine. No account is required and no telemetry is collected.
- **Review-first agents.** Every agent task presents a plan naming its context,
  expected artifacts, likely side effects, approvals, and budgets before it
  runs. No hidden agent swarm.
- **Explicit context.** The user selects and inspects browser context before it
  is shared with any agent.
- **Honest messaging.** Implemented work and planned work are distinguished
  everywhere, including in this README.

## Security posture

The Electron main process is trusted; the renderer and all guest views are not.
Guest content runs with `contextIsolation`, no Node integration, and the sandbox
enabled, in an app-owned session partition. Navigation is restricted to HTTP(S)
plus the single internal page `about:blank`. Browser permission requests are
denied by default. Per-agent credentials are encrypted with Electron
`safeStorage`; if OS encryption is unavailable, OpenStrawberry refuses to store
the credential rather than falling back to plaintext.

Raw credentials, browser passwords, session tokens, and absolute local paths are
kept out of the renderer, snapshots, orchestrator plans, logs, error messages,
artifacts, and fixtures.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Development

Requires Node 24+ and pnpm 11+.

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm dev
```

Validation gate, run before any milestone is considered complete:

```bash
pnpm install --frozen-lockfile && pnpm check && pnpm test && pnpm build
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — trust boundaries and runtime ownership
- [`docs/SECURITY.md`](docs/SECURITY.md) — security controls and residual risks
- [`docs/RELEASES.md`](docs/RELEASES.md) — signed release policy and artifact rules
- [`docs/UPDATES.md`](docs/UPDATES.md) — updater state machine and activation gate
- [`docs/OPENSTRAWBERRY_PLAN.md`](docs/OPENSTRAWBERRY_PLAN.md) — product plan

## Design

The visual system is called **Obsidian Relay**: a warm near-black canvas,
restrained white and grey hierarchy, compact tool surfaces, cool-tinted
translucent glass on chrome only, and motion that communicates state rather than
decorating it. Page content stays content-first and readable.

The system is original. It draws general lessons — density, hierarchy,
monochrome contrast, control sizing, interaction state — from publicly visible
products. No third-party artwork, brand expression, screenshots, code, or
product-specific layout is reproduced.

## Licence

[MIT](LICENSE)
