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

## Browser views

`BrowserManager` owns one sandboxed `WebContentsView` per tab, all sharing the
app-owned persistent partition `persist:openstrawberry-default`.

### Why `WebContentsView` and not `BrowserView`

The original specification named `BrowserView`. Electron has deprecated that
class since version 29 in favour of `WebContentsView`. OpenStrawberry uses the
supported successor: the architecture is identical — native views owned by the
trusted process, sandboxed, session-partitioned, positioned by the main process
from renderer-reported bounds — without building on an API scheduled for
removal.

### Layout

The renderer measures each pane and reports its bounds. The main process
attaches exactly the views that should be visible and detaches the rest.
Inactive tabs stay alive but unattached, so switching back is instant while only
visible views cost compositing.

Panes in the renderer are empty measured regions. Nothing may be painted inside
them, because the real page is a native view composited into exactly those
bounds.

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
authority. HTTP(S) is allowed, plus exactly `about:blank` — compared exactly, so
`about:blank#x` and `about:srcdoc` are refused. URLs carrying embedded
credentials are refused because they are a phishing staple and would otherwise
be carried into history and session restore.

The policy is enforced in three places: the address bar, the guest view's
`will-navigate` and `will-redirect` guards, and session restore. Address input
carrying an explicit scheme is judged as a URL and refused on its merits rather
than rewritten into a search, which would hide the refusal from the user.

## Persistence

Only bounded metadata is persisted: tab URLs, pane assignment, active pane,
split state. The persisted shape has nowhere to put cookies, session tokens,
passkeys, payment data, passwords, or API keys.

A corrupt or foreign session file yields an empty session rather than throwing,
so a bad file can never wedge startup.
