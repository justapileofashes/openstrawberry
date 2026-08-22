# OpenStrawberry

> **WORK IN PROGRESS.** OpenStrawberry is an active development build. The
> installers below are an unsigned prerelease: they will warn on SmartScreen and
> Gatekeeper, and they are not a stable release. Install them only if you are
> comfortable with that.

A local-first, open-source desktop browser with browser-native AI Companions,
review-first multi-agent orchestration, per-agent encrypted credentials, and
privacy-aware migration. Real Chromium browsing, not a mockup.

## Download

Pick your platform:

[![Download for macOS](https://img.shields.io/badge/Download-macOS-f3f1f4?style=for-the-badge&logo=apple&logoColor=white&labelColor=1a191d)](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-mac-universal.dmg)
[![Download for Windows](https://img.shields.io/badge/Download-Windows-f3f1f4?style=for-the-badge&logo=windows&logoColor=white&labelColor=1a191d)](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-win-x64.exe)
[![Download for Linux](https://img.shields.io/badge/Download-Linux-f3f1f4?style=for-the-badge&logo=linux&logoColor=white&labelColor=1a191d)](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-linux-x86_64.AppImage)

> **These installers are unsigned and unnotarised.** Windows SmartScreen and
> macOS Gatekeeper will warn about them. They carry no provenance beyond their
> published checksums, and they are a development build rather than a stable
> release. Verify what you downloaded against `SHA256SUMS.txt` on the
> [release page](https://github.com/justapileofashes/openstrawberry/releases)
> before running it.

Every artifact, including the Linux packages the button row does not cover:

| Platform | Installer |
|---|---|
| macOS (Apple silicon and Intel) | [`OpenStrawberry-mac-universal.dmg`](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-mac-universal.dmg) |
| Windows 10 and 11, 64-bit | [`OpenStrawberry-win-x64.exe`](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-win-x64.exe) |
| Linux — runs anywhere | [`OpenStrawberry-linux-x86_64.AppImage`](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-linux-x86_64.AppImage) |
| Linux — Debian and Ubuntu | [`OpenStrawberry-linux-amd64.deb`](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-linux-amd64.deb) |
| Linux — Fedora and RHEL | [`OpenStrawberry-linux-x86_64.rpm`](https://github.com/justapileofashes/openstrawberry/releases/download/v0.1.1-alpha.1/OpenStrawberry-linux-x86_64.rpm) |

Or build it yourself — an unsigned local build is fine to run, and only
distribution is gated:

```bash
pnpm install --frozen-lockfile && pnpm package
```

## Status

There is **no stable release**. The current published version is
**v0.1.1-alpha.1**, an unsigned prerelease — see [Download](#download). The
in-app updater is on and will offer you further unsigned prereleases; it never
checks or installs without being asked. Nothing in this repository should be
treated as production software.

| Area | State |
|---|---|
| Desktop shell (Electron, hardened main/preload/renderer split) | Built |
| Real Chromium browsing, tabs, split panes | Built |
| Obsidian Relay chrome | Built; responsive behaviour below the minimum width outstanding |
| Migration and encrypted password staging | Built; not yet exercised end to end against real exports on every platform |
| Agent panel and encrypted per-agent credential store | Built |
| HTTP providers and local CLI adapters | Built. A configured agent sends prompts to a provider and can start an allowlisted local program — see [`docs/SECURITY.md`](docs/SECURITY.md) for what each is permitted |
| Review-first orchestration | Built. A plan is reviewed and approved before any step runs |
| Browser fundamentals (downloads, tracker blocking, reader mode, media controls, tab groups, workspaces, command palette) | Built |
| Updater | On, against GitHub Releases, with a real `electron-updater` transport behind the gate. Checking, downloading, and installing are three explicit user actions — nothing happens on launch and nothing installs itself. It updates to *unsigned* prereleases, and macOS cannot apply an unsigned update at all; see [`docs/UPDATES.md`](docs/UPDATES.md) |
| Three-platform packaging | All five artifacts build and verify on their own runners. Neither the DMG nor the Linux packages have been launched on their platforms |
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

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — trust boundaries, capability surface, and runtime ownership
- [`docs/SECURITY.md`](docs/SECURITY.md) — security controls and residual risks
- [`docs/MIGRATION_PRIVACY.md`](docs/MIGRATION_PRIVACY.md) — exactly what migration reads, refuses to read, and writes
- [`docs/RELEASES.md`](docs/RELEASES.md) — signing gate, artifact rules, and the unsigned-prerelease exception
- [`docs/UPDATES.md`](docs/UPDATES.md) — updater state machine and activation gate
- [`docs/OPENSTRAWBERRY_PLAN.md`](docs/OPENSTRAWBERRY_PLAN.md) — product plan and milestone status

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
