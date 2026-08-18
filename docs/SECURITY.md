# Security

OpenStrawberry is work in progress and has not been independently audited. This
document records the controls that exist today and the risks that remain.

## Reporting

Report suspected vulnerabilities privately through the repository's security
advisory form rather than a public issue. There is no stable release yet, so
there is no supported version to patch.

## Process model

The Electron main process is trusted. The renderer and every guest view are
not. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full boundary.

Windows are created with `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, `webviewTag: false`, and `allowRunningInsecureContent: false`.
`app.enableSandbox()` runs before the app is ready so the sandbox applies to
every renderer the process later creates.

Guest views receive **no preload at all**, so guest content has no
OpenStrawberry surface to reach for.

## Controls in place

| Control | Where |
|---|---|
| Sender verification on every renderer-reachable channel | `src/main/ipc-security.ts`, `src/main/ipc-router.ts` |
| Runtime payload validation with no coercion and bounded lengths | `src/shared/ipc-validation.ts` |
| Prototype-pollution rejection on all object payloads | `src/shared/ipc-validation.ts` |
| Error redaction before anything crosses to the renderer | `src/main/ipc-security.ts` |
| Scheme allowlist enforced at the address bar, on the guest, and on restore | `src/shared/navigation.ts` |
| Embedded-credential URLs refused | `src/shared/navigation.ts` |
| HTTPS-only favicons, fetched uncredentialed and read under a hard byte cap | `src/shared/navigation.ts`, `src/main/favicon.ts` |
| Permission requests denied by default on every session | `src/main/index.ts` |
| Chrome cannot navigate away or open native windows | `src/main/index.ts` |
| Strict Content-Security-Policy in the packaged renderer | `vite.config.ts` |
| Session file restricted to bounded metadata | `src/shared/browser.ts` |
| Migration reads nothing until a source is chosen; no renderer-supplied path | `src/main/migration-manager.ts`, `src/main/migration-sources.ts` |
| Bounded, defensive parsers for every foreign file migration reads | `src/main/bookmark-parsers.ts`, `src/main/password-csv.ts` |
| Staged credentials encrypted with `safeStorage`, with no read path | `src/main/migration-store.ts` |
| Every store written whole or not at all, owner-only on each write | `src/main/atomic-write.ts` |

The renderer's Content-Security-Policy is relaxed only while the Vite dev server
is serving, never in the built output.

## Data boundaries

Raw credentials, browser passwords, session tokens, and absolute local paths are
kept out of the renderer, browser snapshots, orchestrator plans, logs, error
messages, artifacts, and fixtures.

OpenStrawberry does not copy cookies, active sessions, account tokens, passkeys,
payment data, extension binaries, or browser passwords, during migration or at
any other time.

Per-agent credentials will be encrypted with Electron `safeStorage`. If OS
encryption is unavailable, OpenStrawberry refuses to store the credential rather
than falling back to plaintext. Credentials staged through migration follow the
same rule and the same cipher.

Migration is consent-first and local-only. What it reads, what it refuses to
read, and what remains a risk are recorded in
[`MIGRATION_PRIVACY.md`](MIGRATION_PRIVACY.md).

## Residual risks

- **Not audited.** No third party has reviewed this code.
- **Unsigned builds.** No artifact is signed or notarised, so a locally built
  installer carries no provenance. Do not distribute one.
- **Tracker blocking is conservative.** It is a bounded, transparent policy with
  per-site exceptions, not a comprehensive ad blocker, and is not claimed to be.
- **Agent surfaces are incomplete.** The registry, provider adapters, CLI
  adapters, and orchestrator are not yet implemented. Each will land with a
  threat model, typed IPC contract, redaction tests, bounded execution policy,
  and user-visible approval state.
- **Third-party search.** Non-URL address input becomes a query to an external
  search engine. This happens only on explicit user input, never implicitly.
- **Dependency surface.** Direct dependencies are pinned to exact versions with
  a committed lockfile, but transitive risk remains.

## Non-goals

OpenStrawberry will not implement DRM or CAPTCHA bypass, hidden cross-site
automation, cookie or session copying, arbitrary shell execution, arbitrary
executable paths, or renderer-supplied subprocess arguments.
