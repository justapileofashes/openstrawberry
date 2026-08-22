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
| Permission requests denied on every session, including the guest partition, which is also left with no display-media handler and so refuses capture outright | `src/main/index.ts` |
| The one narrowing of that denial: on Windows, from the trusted chrome WebContents alone, a `media` request naming no media type is answered with loopback system audio. Video is never granted — the handler has no branch that returns a video source, and a microphone or camera request names a type and is refused | `src/main/loopback-audio.ts` |
| Chrome cannot navigate away or open native windows | `src/main/index.ts` |
| Strict Content-Security-Policy in the packaged renderer | `vite.config.ts` |
| Session file restricted to bounded metadata | `src/shared/browser.ts` |
| Download paths chosen in the trusted process and never crossed to the renderer; server-suggested names flattened, stripped of control characters and bidi overrides, and refused as hidden files or Windows device names | `src/main/download-manager.ts` |
| Reader mode reads the already-loaded DOM and returns blocks carrying a kind from a closed set and a plain string — no markup, URL, attribute, or style field exists for content to travel in | `src/main/reader.ts`, `src/shared/reader.ts` |
| Media control takes an action identifier from a closed set; the trusted process holds one fixed script per action, so no renderer-supplied string is ever evaluated in a page | `src/main/media.ts`, `src/shared/media.ts` |
| Tab-group colours are tokens from a shipped palette, never CSS values, so stored state cannot reach a style attribute | `src/shared/tab-groups.ts` |
| Workspaces store addresses and labels only, with the http(s) gate applied on write and again on read, so a hand-edited file cannot introduce a scheme | `src/shared/workspaces.ts`, `src/main/workspace-store.ts` |
| Migration reads nothing until a source is chosen; no renderer-supplied path | `src/main/migration-manager.ts`, `src/main/migration-sources.ts` |
| Bounded, defensive parsers for every foreign file migration reads | `src/main/bookmark-parsers.ts`, `src/main/password-csv.ts` |
| Staged credentials encrypted with `safeStorage`, with no read path | `src/main/migration-store.ts` |
| Every store written whole or not at all, owner-only on each write | `src/main/atomic-write.ts` |
| Provider requests refuse redirects, so a 302 cannot be handed the key | `src/main/http-provider.ts` |
| A credential is added to a request and nowhere else; the module that shapes requests never receives one | `src/shared/provider-request.ts`, `src/main/http-provider.ts` |
| Credential-shaped tokens scrubbed from task text before it is stored or sent | `src/shared/agents.ts` |
| Local commands allowlisted by executable name, spawned with no shell, prompt on stdin | `src/main/cli-provider.ts` |
| Child processes given a rebuilt environment, so a key in the parent's does not travel | `src/main/cli-provider.ts` |
| A spawned CLI is invoked with its own tools off, so the browser is the only thing a run can touch | `src/main/cli-provider.ts` |
| The browser tools an agent may call are a closed set with no way to name a selector, a coordinate, a file, or a scheme other than http(s) | `src/shared/browser-tools.ts` |
| An agent reads only the tabs the user granted it, plus tabs it opened itself; anything else is refused without the user being asked | `src/main/browser-tools.ts` |
| Clicking and typing are dispatched as real input events at a rectangle this process captured, so no action evaluates a string in a page | `src/main/browser-input.ts` |
| An element reference expires when the tab navigates or the capture ages, so an action cannot land on whatever replaced what it named | `src/main/snapshot-registry.ts` |
| Touching a page is asked once per run; submitting a form, and every tool that rearranges the browser, stops every time | `src/shared/browser-tools.ts`, `src/main/browser-tools.ts` |
| Typing into a password field and touching a file picker are refused outright rather than offered as an approval | `src/main/browser-tools.ts` |
| A password field's contents are never read into a snapshot, at the script and again at the boundary | `src/main/page-snapshot.ts`, `src/shared/page-snapshot.ts` |
| Every browser action that changes something stops for the user's approval, and an unanswered gate refuses itself rather than holding a run open | `src/main/agent-manager.ts` |
| Everything derived from a page reaches a model inside a marked block with a per-call nonce, so page text cannot close it and continue as instruction | `src/shared/trust-boundary.ts` |
| Links and elements read out of a page are re-derived and re-gated on this side, so a page cannot put a `javascript:` address or a chosen reference in front of an agent | `src/shared/browser-tools.ts`, `src/shared/page-snapshot.ts` |
| A `run` script executes in a hidden renderer with no Node, no network, and no page origin, and reaches only the same tools with the same grants and gates | `src/main/script-sandbox.ts`, `src/preload/sandbox.cts` |
| The agent-facing socket is loopback-only on an OS-chosen port, needs a per-run bearer token compared by digest, exists only while a run does, and refuses any request carrying an `Origin` | `src/main/mcp-server.ts` |
| The session token reaches a child in an owner-only file, never in argv where a process listing would show it | `src/main/mcp-server.ts`, `src/main/cli-provider.ts` |
| A tool loop on an API key is bounded in turns and transcript size, and closes by asking once more with the tools withdrawn | `src/main/browser-agent.ts`, `src/shared/provider-request.ts` |
| Page text an agent read stays in live state and is dropped before anything is written to disk | `src/shared/agents.ts` |
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

Per-agent credentials are encrypted with Electron `safeStorage` and written to
`agent-credentials.enc`; the profile and state files beside it hold provider and
model metadata and have no field a key would fit in. If OS encryption is
unavailable, OpenStrawberry refuses to store the credential rather than falling
back to plaintext — and a keyringless Linux session counts as unavailable
however cheerfully `safeStorage` answers, with any key an earlier build wrote
through that fallback discarded at startup. Credentials staged through migration
follow the same rule and the same cipher.

Migration is consent-first and local-only. What it reads, what it refuses to
read, and what remains a risk are recorded in
[`MIGRATION_PRIVACY.md`](MIGRATION_PRIVACY.md).

## Residual risks

- **Not audited.** No third party has reviewed this code.
- **The published installers are unsigned.** v0.1.1-alpha.1 is a prerelease with
  no Authenticode signature and no notarisation. SmartScreen and Gatekeeper warn
  about it, and the only integrity claim it carries is HTTPS to GitHub plus the
  published SHA-256 manifest — which establishes that the bytes arrived intact
  from that release, not who produced them. Locally built artifacts carry even
  that much less; do not distribute one.
- **The updater downloads and runs unsigned code.** It is the sharpest edge of
  the point above: an update is fetched from a release and executed, with no
  signature to verify at install time. The controls that remain are the
  three-fact activation gate, the fact that checking, downloading, and
  installing are three separate deliberate acts, and transport security. See
  [`UPDATES.md`](UPDATES.md).
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
    travel to the child. argv holds a fixed invocation the app keeps, which asks
    the tool for one non-interactive turn with its own configuration and tool set
    switched off; a tool that cannot call a tool cannot read or write a file on
    the machine while answering.
  - Neither happens until a user configures a provider or a command. A default
    install has no credential, and an agent with no route reports that rather
    than doing anything.
- **A prompt leaves the machine.** When an HTTP provider is configured, the task
  text and the names of granted tabs are sent to that provider. Credential-shaped
  tokens are scrubbed from task text first, but that is a mitigation and not a
  guarantee: anything else a user types is sent as typed.
- **An agent can drive the browser, and the browser is signed in.** This is the
  sharpest thing in the application, and the controls on it are stated in full
  rather than summarised:
  - **What it can do is a closed list.** Fourteen tools, in
    `src/shared/browser-tools.ts`. Five read, three touch a page, six change what
    the browser is doing. There is no tool that names a CSS selector, an XPath, a
    raw coordinate, a file, or a scheme other than http(s), and the parser has no
    default branch, so this is checkable rather than intended.
  - **An element is named by a reference this process minted.** `snapshot`
    returns `e12`-style references built from a capture the trusted process took;
    a model cannot supply a locator of its own. Clicking and typing are then
    dispatched as real input events at the rectangle that capture recorded, so no
    action evaluates anything inside a page.
  - **A reference expires.** The tab engine counts navigations, in-page ones
    included, and a capture also ages out. A reference from before either is
    refused rather than resolved, because a stale reference does not miss â€” it
    points at whatever now occupies that position.
  - **What it can see is what the user granted.** A run may read the tabs
    selected when it was started, plus tabs it opened itself. Everything else is
    refused, and refused without asking the user, so an agent cannot learn a tab
    exists by being told it may not touch it.
  - **Touching a page is asked once; the irreversible is asked every time.**
    Clicking and typing at all raise one approval per run, because a prompt per
    keystroke is a prompt people learn to click through and consent nobody reads
    is not consent. Submitting a form â€” a click on a submit control, or Enter
    inside one â€” stops separately and every time, as do opening, navigating,
    closing, and moving through history. A denial returns an error to the agent
    rather than failing the run, so it adapts instead of retrying. This is the
    control; as with orchestration, its safety rests on people reading the
    request.
  - **Some things are refused, not offered.** Typing into a password field and
    touching a file picker raise no prompt at all, because there is no version of
    either an agent should do on someone's behalf. A password field's contents
    are never read into a snapshot in the first place.
  - **A page's text is read into a run and shown, but not written.** Step details
    for tool calls, tool results, and errors are dropped before state reaches
    disk, so the contents of a signed-in page do not outlive the window in plain
    JSON.
  - **Page content is untrusted input to a model, and is marked as such.**
    Everything derived from a page arrives inside an `untrusted-page-content`
    block carrying a nonce minted per call, so page text cannot close the block
    and continue at the instruction level. That is a mitigation, not a
    guarantee: nothing in a page can widen a grant, reach a tool outside the
    closed set, or answer an approval, but a model can still be argued into
    asking for something, and the gate is what stands between that and the
    browser acting on it.
  - **A script runs where it can reach nothing.** The `run` tool evaluates a body
    an agent wrote â€” the one place in this feature that does â€” in a hidden
    renderer with no Node, no network, no page origin, and one function exposed
    to it. Every call it makes re-enters the same executor with the same grants
    and the same approvals, so it composes existing authority and adds none. It
    is bounded in time, in calls, in length, and in what it may return.
  - **A local socket exists while a run does.** Handing the browser to a separate
    coding CLI means binding a loopback port. It is bound to `127.0.0.1` on an
    OS-chosen port, requires a bearer token minted per run and destroyed with it,
    refuses any request carrying an `Origin` header, and does not exist at all
    when no run is using it. The token reaches the child in an owner-only file
    rather than on a command line.
  - **None of it happens by itself.** A run with no granted tabs and no approval
    granted can read nothing and change nothing.
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
program, not for whatever happens to sit at that path.

The arguments passed are a fixed table this app holds, one entry per supported
program, and the prompt is written to stdin — so there is no command line
assembled from anything typed, and none for a task to be smuggled into. Exactly
one value in argv comes from settings: a model name, which the IPC validator has
already constrained to characters that cannot spell a flag, and which is checked
again against that charset in
[`src/main/cli-provider.ts`](../src/main/cli-provider.ts) before it is placed.
