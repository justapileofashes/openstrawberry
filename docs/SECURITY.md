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
| Provider requests refuse redirects, so a 302 cannot be handed the key | `src/main/http-provider.ts` |
| A credential is added to a request and nowhere else; the module that shapes requests never receives one | `src/shared/provider-request.ts`, `src/main/http-provider.ts` |
| Credential-shaped tokens scrubbed from task text before it is stored or sent | `src/shared/agents.ts` |
| Local commands allowlisted by executable name, spawned with no shell, prompt on stdin | `src/main/cli-provider.ts` |
| Child processes given a rebuilt environment, so a key in the parent's does not travel | `src/main/cli-provider.ts` |
| Plans do not run until approved, and a step reads only the tabs it was granted | `src/shared/orchestration.ts` |
| Updates gated on a conjunction of packaged, release-ready, and channel-enabled | `src/shared/updates.ts`, `src/main/update-manager.ts` |
| A canary suite asserting no stored credential reaches any snapshot, file, or error | `src/main/agent-redaction.test.ts` |

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
- **Agents now reach the network and the process table.** This is the largest
  change to the threat model since the browser core, and it is stated plainly
  because the previous version of this document said these surfaces did not
  exist:
  - A configured agent sends a prompt, with a stored credential, to an HTTPS
    endpoint the user chose. Redirects are refused rather than followed, so a
    302 cannot hand the key to another host; the request is bounded in time and
    the reply bounded in size; and a provider's own error text is never shown or
    logged, because it can echo the request back.
  - A configured agent starts a program on this machine. It is spawned with an
    argv array and never a shell, the executable's base name must be one this
    app ships support for, the prompt goes in on stdin rather than argv where a
    process listing would show it, and the environment is rebuilt from a fixed
    list rather than inherited — so a key in the parent's environment does not
    travel to the child.
  - Neither happens until a user configures a provider or a command. A default
    install has no credential, and an agent with no route reports that rather
    than doing anything.
- **A prompt leaves the machine.** When an HTTP provider is configured, the task
  text and the names of granted tabs are sent to that provider. Credential-shaped
  tokens are scrubbed from task text first, but that is a mitigation and not a
  guarantee: anything else a user types is sent as typed.
- **Orchestration is review-first, and that is the control.** A plan does not
  run until a person approves it, a step reads only the tabs it was granted, and
  a gated step waits for a decision. The safety of the feature rests on people
  reading plans before approving them.
- **Third-party search.** Non-URL address input becomes a query to an external
  search engine. This happens only on explicit user input, never implicitly.
- **Dependency surface.** Direct dependencies are pinned to exact versions with
  a committed lockfile, but transitive risk remains.

## Non-goals

OpenStrawberry will not implement DRM or CAPTCHA bypass, hidden cross-site
automation, cookie or session copying, shell execution, or renderer-supplied
subprocess arguments.

It will not run an arbitrary executable. A user may point a CLI route at a
program anywhere on disk, because a tool installed under a version manager is
not on a predictable path — but the file's base name must be one of the tools
this app ships support for. Configuring a path is authorisation for that
program, not for whatever happens to sit at that path. No argument is ever
passed, and the prompt is written to stdin, so there is no command line for
anything to be smuggled into.
