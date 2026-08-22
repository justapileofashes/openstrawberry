# Architecture

OpenStrawberry is an Electron application with a hardened boundary between a
trusted native process and an untrusted presentation layer.

## Trust boundaries

| Layer | Owns | Must never own |
|---|---|---|
| Main process | Native views, session partitions, OS storage, downloads, migration, updater, encrypted vault, provider calls, CLI processes | Renderer-only visual state |
| Preload | A narrow typed capability bridge | Arbitrary filesystem, Node, shell, or unrestricted IPC access |
| Renderer | Browser chrome, tab rail, panes, Agent rail, Control Panel, update UI | Raw credentials, subprocesses, local file access |
| Guest views | Website rendering | Node integration or any OpenStrawberry internal surface |
| Shared modules | Validators, snapshot types, protocols, navigation policy | UI-specific mutable state |

The main process is trusted. Everything else is not, including OpenStrawberry's
own chrome.

## IPC

Every renderer-reachable channel is registered through a single router
([`src/main/ipc-router.ts`](../src/main/ipc-router.ts)) that applies three steps
in a fixed order with no per-channel opt-out:

1. **Verify the sender.** The message must originate from the top-level frame of
   the exact `WebContents` hosting the chrome, served from the packaged `file:`
   bundle or a loopback dev server. Guest views hold different `WebContents`
   ids and can never match, and a subframe is rejected even inside the trusted
   `WebContents`.
2. **Validate the payload.** No coercion, bounded string and collection lengths,
   and rejection of prototype-polluting keys.
3. **Redact failures.** Main-process errors routinely carry absolute local paths
   and could carry credential material, so only deliberately authored
   validation and security errors pass back; everything else collapses to a
   generic message and is logged in the trusted process.

The policy checks in [`src/main/ipc-security.ts`](../src/main/ipc-security.ts)
are pure functions over a minimal event shape so they are unit tested without
booting Electron.

### Preload constraints

A sandboxed preload may only `require('electron')`, never a local module, so
[`src/preload/index.cts`](../src/preload/index.cts) is self-contained. Shared
contracts are imported as types, and channel names are inlined but pinned to the
shared contract at compile time so the two cannot drift apart.

The preload is authored as `.cts` and compiles to CommonJS `.cjs`, which is what
packaged sandboxed Electron loads.

### Capability surface

`window.openstrawberry` is thirteen named capability groups, each defined in
[`src/shared/bridge.ts`](../src/shared/bridge.ts) and each bound to a fixed set
of channels. There is no generic `invoke` and no renderer-controlled channel
name, so the surface can only grow by someone adding a function here on purpose.

| Group | What it reaches |
|---|---|
| `shell` | Platform string and one-shot shell info |
| `window` | Minimise, maximise, close, and window state |
| `browser` | Tabs, navigation, panes, split state, viewport bounds, tab groups |
| `agents` | Companion roster, runs, approvals, credential status, orchestrator selection |
| `migration` | The wizard: detection, preview, native pickers, commit, and imported-bookmark search |
| `downloads` | Per-item state, pause, resume, cancel, reveal, clear |
| `tracking` | Blocker state, per-site exceptions |
| `reader` | Open a text-only reading view over the loaded tab |
| `workspaces` | Save, open, and remove named address snapshots |
| `media` | Read media state and run one action from a closed set |
| `plans` | Propose, approve, resolve a step, cancel |
| `updates` | Check, download, install, and the state behind them |
| `defaultBrowser` | Read registration state and request it |

The groups whose state changes without the renderer asking â€” `window`,
`browser`, `agents`, `downloads`, `tracking`, `plans`, `updates` â€” also push a
snapshot on a state event, so the chrome re-renders from one authority rather
than polling. The rest change only in response to a call and return the new
state from it.

## Browser views

`BrowserManager` owns one sandboxed `WebContentsView` per tab, all sharing the
app-owned persistent partition `persist:openstrawberry-default`.

### Why `WebContentsView` and not `BrowserView`

The original specification named `BrowserView`. Electron has deprecated that
class since version 29 in favour of `WebContentsView`. OpenStrawberry uses the
supported successor: the architecture is identical â€” native views owned by the
trusted process, sandboxed, session-partitioned, positioned by the main process
from renderer-reported bounds â€” without building on an API scheduled for
removal.

### Layout

The renderer measures each pane and reports its bounds. The main process
attaches exactly the views that should be visible and detaches the rest.
Inactive tabs stay alive but unattached, so switching back is instant while only
visible views cost compositing.

Panes in the renderer are empty measured regions. Nothing may be painted inside
them, because the real page is a native view composited into exactly those
bounds.

### The one thing drawn above a page

Because a page is composited above the chrome's document, the chrome can only
paint where no view reaches. Hover text for the tab rail cannot obey that: a rail
entry is 56px of chrome with a pane immediately beside it, so its bubble has
nowhere inside the chrome to go.

[`BubbleLayer`](../src/main/bubble-layer.ts) is the exception, and is meant to
stay the only one. It holds a small transparent child window above the chrome and
draws one label into it. It never takes focus and never takes a click, so it
cannot come between the user and the page it floats over; it is placed from
client coordinates the renderer measured and the trusted process clamps against
the chrome's own bounds, so a bubble can only ever be drawn over OpenStrawberry;
and it is shown only once the text it was given has been painted, so it cannot
appear at one control carrying another's name. Its text is set as `textContent`,
which is what keeps a tab title — chosen by the page — from becoming markup in a
window that floats above every page.

Bubbles that do fit inside the chrome are still plain DOM and never cross IPC.
The stylesheet's `--bubble-lane` measures the chrome left below a top-bar button,
and those bubbles are anchored by their bottom edge to it.

### Teardown

A window can begin closing between any two lifecycle events. Views are released
from the window's `close` event, before destruction, and again from `closed` as
an idempotent backstop. Every detach guards against an already-destroyed parent
and tolerates the underlying view having gone away.

Releasing views only at `closed` touches an already-destroyed parent and
surfaces an `Object has been destroyed` dialog on exit. Do not reintroduce an
unconditional removal from a late handler.

## Navigation policy

[`src/shared/navigation.ts`](../src/shared/navigation.ts) is the single
authority. HTTP(S) is allowed, plus exactly `about:blank` â€” compared exactly, so
`about:blank#x` and `about:srcdoc` are refused. URLs carrying embedded
credentials are refused because they are a phishing staple and would otherwise
be carried into history and session restore.

The policy is enforced in three places: the address bar, the guest view's
`will-navigate` and `will-redirect` guards, and session restore. Address input
carrying an explicit scheme is judged as a URL and refused on its merits rather
than rewritten into a search, which would hide the refusal from the user.

## Agents

An agent reaches the outside world by exactly one of two routes, both owned by
the main process. The renderer never holds a credential, an executable path, or
a request.

| Route | Module | Boundary it keeps |
|---|---|---|
| HTTP provider | [`src/main/http-provider.ts`](../src/main/http-provider.ts) | Redirects are refused rather than followed, so a 302 cannot be handed the key. Bounded in time and response size. The provider's own error text is never shown or logged, because it can echo the request back |
| Local CLI | [`src/main/cli-provider.ts`](../src/main/cli-provider.ts) | Spawned with an argv array and never a shell; the executable is allowlisted by base name; the prompt goes in on stdin, never argv, where a process listing would show it; argv is a fixed invocation the app holds; the environment is rebuilt from a fixed list rather than inherited |

Request *shaping* lives in
[`src/shared/provider-request.ts`](../src/shared/provider-request.ts), which
never receives a credential â€” the trusted process adds the header immediately
before sending. That split is why a shaping bug cannot become a credential leak.

Sixteen providers are supported across the two transports:
nine HTTP dialects (Anthropic, OpenAI, Google, OpenRouter, OmniRoute, Moonshot,
Qwen, Ollama, and generic OpenAI-compatible) and seven local coding CLIs (Claude
Code, Codex, Antigravity, Gemini CLI, OpenCode, Kimi Code, Qwen Code). A CLI
route brings its own sign-in, so there is no key for OpenStrawberry to store and
the sensitive setting is which program runs rather than where a secret goes.

A CLI route also brings its own bill. Started bare, a coding CLI comes up as
though a person were about to sit in front of it: it loads the MCP servers,
skills, plugins, hooks, and project memory its user configured, mounts its whole
built-in tool set, and then runs an agentic loop that resends all of it every
turn. This adapter hands over one prompt and reads back one block of text, so
none of that is reachable â€” it is context the user pays for and never sees.
`CLI_INVOCATIONS` in
[`src/main/cli-provider.ts`](../src/main/cli-provider.ts) therefore holds a fixed
argv per program asking for exactly what the adapter uses: one non-interactive
turn, no configuration, and no tools it was not given on purpose. Measured
against the installed Claude Code,
that is 4,788 tokens of context rather than 28,214, and one turn rather than as
many as the tool decides to take. Only tools whose flags have been checked
against the real CLI have an entry; a program without one is spawned bare, as
before, because a guessed flag does not make a route cheaper â€” it makes it exit
non-zero before doing any work.

### Agents and the browser

An agent can see and drive the tabs a user granted it. There is one set of tools,
one grant boundary, and one approval gate; what differs between routes is only
who is holding the conversation.

The loop is **snapshot, act, verify**, and each third of it is a deliberate
answer to a question a browser agent cannot avoid.

**How does it see a page?** `snapshot` returns a flat list of the elements worth
acting on, each carrying a reference like `e12`
([`src/shared/page-snapshot.ts`](../src/shared/page-snapshot.ts)). That reference
is the whole locator strategy: there is no CSS selector, no XPath, and no raw
coordinate anywhere in the contract, because all three are strings a model
invents and this process would then have to trust. A reference is an index into
a list this process built, so the worst a wrong one can do is miss. References
are minted here rather than read from the page, and they are renumbered by every
capture.

**How does it act?** `act` takes a batch of steps — click, hover, type, fill,
press, scroll, check, uncheck, select — and dispatches each as a **real input
event** at the rectangle the snapshot recorded
([`src/main/browser-input.ts`](../src/main/browser-input.ts)). Nothing is
evaluated in the page: no selector is resolved, no `.click()` is called, and
there is no code path from a tool call to `executeJavaScript` at all. Two things
follow. The events are trusted, so a site that gates on `isTrusted` behaves for
an agent as it does for a person; and a controlled input in a framework takes the
value, because typing produces the same `keydown`/`input`/`keyup` a keyboard
produces rather than an assignment that fires nothing.

**How does it know it worked?** Every action ends by settling, re-capturing, and
returning a **diff** — what appeared, what went, what changed state. A click that
lands on nothing is the failure a browser agent has most often, and the only way
to catch it is to look afterwards.

[`src/shared/browser-tools.ts`](../src/shared/browser-tools.ts) is the whole
contract: fourteen tools, their schemas, which of them change something, and the
wording every result and every approval is written in. Five read — `list_tabs`,
`snapshot`, `read_page`, `page_links`, `wait_for`; three touch a page —
`act`, `screenshot`, `run`; six change what the browser is doing — `open_tab`,
`navigate_tab`, `close_tab`, `go_back`, `go_forward`, `reload_tab`. The set is
closed and `parseBrowserToolCall` has no default branch, so that is checkable
rather than intended.

[`src/main/browser-tools.ts`](../src/main/browser-tools.ts) executes a call
against the same narrow `BrowserPort` the agent runtime already had. The two
scripts that run inside a guest page — the link scan and the element walk — are
constants held there, following the same discipline as reader mode and media
control: what a page hands back is untrusted JSON, and every field is re-derived,
including re-applying the http(s) gate so a page cannot put a `javascript:`
address in front of an agent by declaring one.

Four things bound what an agent may reach:

- **Grants.** A run may read the tabs the user picked when they started it, plus
  any tab the run itself opened. A tab outside that set is refused without the
  user being asked, because a gate on a tab the run was never given could only
  ever be answered wrongly. `list_tabs` says which tabs are the run's own and
  which are the user's.
- **Freshness.** A reference is only usable while the capture that minted it is
  ([`src/main/snapshot-registry.ts`](../src/main/snapshot-registry.ts)). The tab
  engine bumps a counter on every navigation, in-page ones included; a counter
  that moved retires every reference for that tab at once, and a capture also
  ages out. Acting on a stale reference is refused with an instruction to look
  again, because such a reference still *resolves* — to whatever now sits in that
  position, which is not a miss but a confident action on the wrong thing.
- **Consent, in two tiers.** Touching a page at all is asked **once per run**: a
  gate per keystroke is a gate people learn to click through, and a three-field
  form would be four prompts. Submitting a form — a click on a submit control, or
  Enter inside one — stops **every time**, as do all six tools that rearrange the
  browser. The run goes to `awaiting-approval`, the panel shows what is being
  asked and why, and the call waits. A denial is not a failure: the tool returns
  an error saying the user declined, so the agent can choose another route rather
  than dying on a "no". An unanswered gate refuses itself after three minutes.
- **Refusals that are not gates.** Typing into a password field and touching a
  file picker have no prompt at all. There is no version of either an agent
  should be doing on someone's behalf, and an approval that is always the wrong
  answer is worse than a refusal. Both are decided from the *element* rather than
  from the act, because the act only ever says "click".

Everything derived from a page — reader text, links, a snapshot, a diff, a
screenshot's caption — is wrapped by
[`src/shared/trust-boundary.ts`](../src/shared/trust-boundary.ts) before it
reaches a model, in a block carrying a nonce minted per call. An agent's context
is one flat stream of text, so nothing in it otherwise distinguishes the task the
user typed from a sentence a page contains; the nonce is what stops page text
closing the block and continuing at the instruction level.

The two routes reach that shared floor differently, because they have to:

| Route | How it gets the browser |
|---|---|
| Local CLI | [`src/main/mcp-server.ts`](../src/main/mcp-server.ts) â€” a separate process cannot be handed an object, so it is handed a socket. The Model Context Protocol over loopback HTTP, spoken by hand rather than through the reference SDK, whose HTTP framework, CORS layer, rate limiter and OAuth client would all be surface on a port this app binds precisely to have as little as possible |
| HTTP provider | [`src/main/browser-agent.ts`](../src/main/browser-agent.ts) â€” a model behind an API key will ask for a tool but cannot make the next request itself, so the loop runs in this process: tools go out with the request, a reply asking for one is executed, and the answer goes back on the next turn |

Five properties hold the socket shut, each enforced rather than assumed of the
client: it is bound to `127.0.0.1` on a port the OS chooses; every request needs
a bearer token minted per run and destroyed with it, compared by digest; the
listener is opened by the first session and closed by the last, so an
OpenStrawberry that never runs a local agent binds nothing at all; any request
carrying an `Origin` header is refused outright, which is the whole
DNS-rebinding defence because the clients it serves are processes and not pages;
and the token reaches the child in a file written owner-only, never in argv,
for the same reason the prompt does not travel in argv.

Handing a CLI one MCP server and nothing else needs its own invocation, because
the flag that turns a coding CLI's whole configuration off turns its MCP servers
off with it â€” including one named on the same command line. `CLI_INVOCATIONS`
therefore holds a second argv per program, checked against the real CLI, stating
each refusal separately. Only Claude Code has one today: Codex reads its MCP
servers from `config.toml` and takes no flag naming a file, so the only way to
hand it one would put the session's bearer token on a command line every process
listing on the machine can read.

For an HTTP route the tools travel in the request, which means four dialects of
the same conversation. `buildChatTurn` renders a neutral transcript into each
provider's spelling and `parseChatOutcome` reads it back, so the loop never
learns which provider it is talking to. The loop is bounded in turns and in
transcript size, and when it runs out of room it asks once more with the tools
withdrawn, so a run ends with an answer rather than with nothing. A model that
refuses a request carrying tools at all is retried once without them, because a
route that answered fine before tools existed must not start failing now.

A step's *detail* is where a page's own text lands, so
`toPersistedAgentState` drops it for `tool-call` and `tool-result` steps before
anything is written. The panel shows a user what their agent actually read; the
file on disk does not, because the contents of a signed-in page must not outlive
the window in plain JSON.

Orchestrated plan steps do not get the browser. A step is executed outside any
`AgentRunState`, so there is nowhere to raise an approval and no panel showing
one; that arrives when the graph grows its own gate rather than by borrowing a
run's.

Credentials are encrypted with `safeStorage` in
[`src/main/secret-store.ts`](../src/main/secret-store.ts), with the platform
judgement â€” including the Linux rule that a keyringless `basic_text` backend is
not encryption â€” isolated in
[`src/main/os-cipher.ts`](../src/main/os-cipher.ts). Profile and run metadata are
persisted in separate files that have no field a key would fit in.
[`src/main/agent-redaction.test.ts`](../src/main/agent-redaction.test.ts) plants
a canary key and serialises every artefact the system produces looking for it, so
a field added later that happens to carry one fails the suite without anyone
remembering to extend it.

## Orchestration

Review-first is structural rather than a check someone remembers to make.
[`src/shared/orchestration.ts`](../src/shared/orchestration.ts) is a pure typed
graph: a plan is built in `draft`, and `readySteps` hands out nothing until a
person approves it. A cycle is refused at construction rather than discovered as
a hang. Context is granted per step and intersected with what is actually open â€”
there is no "all tabs" value and no way to widen a grant after approval. The
budget is spent at the start rather than checked afterwards. A failed dependency
blocks what needed it rather than skipping it, so work that was not done stays
visible.

[`src/main/plan-runner.ts`](../src/main/plan-runner.ts) drives whatever the graph
offers and stops at every gate. It cannot start a step the graph did not offer,
because `readySteps` is its only way of obtaining one â€” there is no second path
into execution to keep consistent with the first. The plan is re-read on every
pass rather than iterated from a list captured at the start, so an approval
arriving mid-flight or a budget running out is seen. The executor is injected;
with none, plans are reviewable and simply never run. A plan step and a chat turn
reach a provider through the same dispatch, because two paths would be two places
to get the credential rule right.

## Updates

Two modules, split so the part deciding *whether* an update may happen never
depends on the part that performs it:
[`src/main/update-manager.ts`](../src/main/update-manager.ts) holds the gate and
the state machine, and [`src/main/update-transport.ts`](../src/main/update-transport.ts)
is the only importer of `electron-updater`. A build that must not update never
loads the updater at all, because the transport is constructed only after the
gate has opened. Full behaviour is in [`UPDATES.md`](UPDATES.md).

## Migration

Migration is the one subsystem that reads another application's data, so it adds
one rule to the boundary above: **the renderer never supplies a path.** A
detected profile is named by an identifier the trusted registry minted and
resolves itself; a picked file is named by an opaque handle minted after the
trusted process opened a native dialog. Neither can be pointed anywhere else, and
neither carries a location back to the chrome.

Detection is a fixed per-platform registry of Chromium profile roots. It never
opens a bookmark file â€” reading happens only after a user names a source and a
category. Firefox and Safari are reached exclusively through an HTML export the
user picks; their internal databases are never opened.

Full behaviour, limits, and residual risks are in
[`MIGRATION_PRIVACY.md`](MIGRATION_PRIVACY.md).

## Persistence

Everything the main process persists lives in the application's own user-data
directory, and every file is written whole or not at all through
[`src/main/atomic-write.ts`](../src/main/atomic-write.ts), owner-only on each
write. A crash or a full disk cannot leave a truncated credential file that
reads as "no key was ever stored".

| File | Contents |
|---|---|
| `session.json` | Tab addresses, pane assignment, active pane, split state, tab-group membership |
| `workspaces.json` | Named snapshots: addresses and labels only |
| `tracking.json` | Blocker enabled state and per-site exceptions. No blocked URL is ever recorded â€” that list would be a browsing history |
| `agent-credentials.enc` | One `safeStorage` ciphertext holding the per-agent keys |
| `agent-profile.json` | Provider, model, and route metadata. No field a key would fit in |
| `agents.json` | Run and companion state, with credential-shaped tokens already scrubbed from task text |
| `bookmarks.json` | Imported bookmarks: title, address, folder path |
| `staged-passwords.enc` | One `safeStorage` ciphertext per staged credential, with no read path |
| `migration.json` | Status, timestamps, counts, chosen categories, and the search provider's display name |

None of these shapes has anywhere to put a cookie, session token, passkey,
payment datum, browser password, or API key â€” for the two `.enc` files, the key
is the ciphertext and there is no plaintext form on disk. That is a property of
the types, not of the code that fills them.

Appearance settings â€” shine, intensity, colour, speed, motion â€” are renderer-owned
and stay in the renderer's own storage
([`src/renderer/settings-store.ts`](../src/renderer/settings-store.ts)); they are
presentation, so the trusted process has no reason to hold them.

A corrupt or foreign file yields empty state rather than throwing, so a bad file
can never wedge startup. Session restore re-checks every group membership against
the groups that actually parsed, and re-applies the http(s) scheme gate on read,
so a hand-edited file cannot introduce a dangling reference or a scheme.
