# Migration privacy

Migration is the one feature that deliberately reads another application's data.
This document records exactly what it reads, what it refuses to read, where what
it keeps is written, and what remains a risk.

Nothing described here runs on its own. The wizard is offered once, on a launch
where migration has neither run nor been dismissed, and every read happens after
an explicit choice.

## What is supported

| Category | Source | How it is obtained |
|---|---|---|
| Bookmarks | Chromium-family profile | The profile's `Bookmarks` JSON file, read after the user names a browser and a profile |
| Bookmarks | Firefox, Safari | An HTML export the user produces and picks in a native file dialog |
| Search engine **display name** | Chromium-family profile | One string from the profile's `Preferences` file |
| Passwords | Any CSV export | A file the user picks in a native dialog, reviewed, then encrypted with `safeStorage` |

## What is intentionally not supported

These are not missing features. There is no code to read them, and no field in
any migration type that could carry one.

- **Cookies, active sessions, and account tokens.** Never copied.
- **Passkeys and payment data.** Never copied.
- **Extensions, extension binaries, and extension settings.** Never copied.
- **Browsing and download history, open tabs, autofill and form data.** Never copied.
- **The browser's own password database.** Chromium's `Login Data`, Firefox's
  `logins.json` and `key4.db`, and the macOS Keychain are never opened. Passwords
  come only from a CSV the user exports and hands over.
- **Firefox `places.sqlite` and Safari's `Bookmarks.plist`.** Never opened. Those
  files are locked while the browser runs and reading them means shipping a
  database engine to parse a format the user cannot inspect. The manual export
  path is the whole story for both browsers, and the wizard says so in place.
- **Anything from a search provider beyond its name.** Not the URL template, not
  the suggestion endpoint, not the keyword, not any key or account setting.
- **Any network activity.** Migration makes no requests. There is no analytics,
  no remote backup, and no synchronisation.

## Trust boundary

Migration follows the same ownership model as the rest of the application; see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

| Layer | Owns |
|---|---|
| Main | The source registry, all filesystem reads, native file dialogs, parsing, encryption, persistence, and error redaction |
| Preload | Eleven named functions on `window.openstrawberry.migration`, each bound to one fixed channel |
| Renderer | The wizard: choices, review, confirmation, progress, cancellation, and every error and empty state |
| Shared | Types, limits, runtime validators, and the IPC payload parsers |

### The renderer never supplies a path

There are exactly two ways to name something to read, and neither is a location.

1. **A detected profile** is named by a `sourceId` and `profileId` that the
   registry in [`src/main/migration-sources.ts`](../src/main/migration-sources.ts)
   minted. Both are validated as identifiers — a character set with no path
   separator in it — and are then resolved through a map only the trusted process
   holds. An identifier that was not minted resolves to nothing and is refused.
   Directory names never cross the boundary in either direction; `Profile 1`
   becomes the identifier `profile-1`, and the mapping back is main-side only.

2. **A picked file** is named by an opaque handle the trusted process minted after
   *it* opened a native dialog and the user answered it. The renderer asks for a
   dialog; it never learns what was chosen.

Every migration channel goes through the same router as every other channel, so
each one verifies that the sender is the top-level frame of the chrome's own
`WebContents`, validates the payload with no coercion, and redacts any failure
before it crosses back.

### Review is binding

A preview parses the chosen source once and keeps the parsed records in the
trusted process against the handle. The commit imports exactly those records.
This is why the file is not re-read at commit time: what the user approved is
what lands, even if the file changes in between.

## Reading rules

Detection checks the fixed registry of profile roots for the current platform and
nothing else. It does not walk the home directory, does not search for browsers,
and never opens a bookmark file — it checks that a profile exists, reads one
display-name index for profile names, and stops. Source directories are opened
read-only and are never written to.

Every parser treats its input as hostile, because it was written by another
program and may have been edited by anyone:

| Bound | Value |
|---|---|
| Bookmark file size | 32 MB |
| CSV file size | 8 MB |
| Bookmark records | 20,000 |
| Bookmark folders | 2,000 |
| Folder nesting depth | 16 |
| Title length | 512 characters |
| Address length | 4,096 characters |
| CSV rows | 20,000 |
| CSV columns | 32 |
| CSV field length | 4,096 characters |
| Review sample shown | 8 entries |

A malformed record is skipped and counted, never a reason to abandon the file.
Every address passes one scheme gate: `http` and `https` only, with embedded
credentials refused. `javascript:`, `data:`, `file:`, `chrome:`, `android:` and
everything else are rejected and reported as a count.

The HTML reader is a tag scanner that recognises four tags — `DL`, `DT`, `H3`,
`A` — and ignores everything else, so scripting, styling, embedded content, and
external references in an export file have no effect.

## Warnings carry no user data

Warnings are a closed set of codes with counts, not free text:

```ts
{ code: "unsafe-url-skipped", count: 4 }
```

This is a deliberate departure from a `string[]`. Free-text warnings are one
careless template literal away from carrying a bookmark title, an address, a CSV
cell, or a profile path into the renderer and the log. A code and a count cannot.
The user-facing sentence for each code lives in
[`src/shared/migration.ts`](../src/shared/migration.ts).

## Passwords

Password staging is a separate, opt-in path. It is never a category that rides
along with a bookmark import.

1. The user picks a CSV in a native dialog opened by the trusted process.
2. It is parsed locally. The review screen sees **counts, recognised column
   names, and warning codes** — never a value.
3. Column names are reported **only when the first row is recognisably a header**.
   A file exported without one would otherwise render a live credential as a
   label, so in that case no names are shown and no row is accepted.
4. A dedicated confirmation step states that entries will be stored with
   operating-system encryption and will not be filled in automatically.
5. On confirmation each record is encrypted individually with Electron
   `safeStorage` and written to `staged-passwords.enc` in the application's
   private data directory with owner-only permissions where the platform honours
   them. Only a count is returned.

If OS encryption is unavailable, **staging is refused**. There is no plaintext
fallback and no path through the code that could produce one. The same judgement
the credential store uses applies here, including the Linux rule that a
keyringless `basic_text` backend is not encryption — see
[`src/main/os-cipher.ts`](../src/main/os-cipher.ts). The wizard disables the
control and explains which of the two situations applies.

The vault class has no `read`, `get`, `decrypt`, or iteration method. Staging
writes ciphertext, `count` counts records without opening one, and `deleteAll`
removes the file. **There is no code path that returns a staged password** — not
to the renderer, not to a page, not to an agent, not to a log. Deleting is always
available, including on a system that can no longer decrypt what it once wrote:
being unable to read a secret is no reason to be unable to remove it.

Staged entries are not autofilled, not synced, and not shown again. "Delete
staged passwords" is available from Settings whenever any exist.

## Agents

No agent can reach any of this. The migration surface is exposed to the chrome
renderer only; parsed records never leave the trusted process; the vault has no
read path; and migration data does not appear in agent context, prompts, plans,
artifacts, logs, or telemetry.

## What is written, and where

All paths are inside the application's own user-data directory.

| File | Contents |
|---|---|
| `bookmarks.json` | Imported bookmarks: title, address, folder path |
| `staged-passwords.enc` | One `safeStorage` ciphertext per staged credential |
| `migration.json` | Status, timestamps, run count, chosen categories, counts, and the search provider's display name |

`migration.json` has no field for a source location, a bookmark, or a secret.
That is a property of the shape, not of the code that fills it.

Both `bookmarks.json` and `migration.json` are written through a temporary file
and a rename, so an import lands whole or not at all — there is no state in which
a partial import is observable. The temporary file is removed if the write fails.

## Cancellation and idempotence

Cancelling drops every reviewed selection, which releases both the parsed
bookmarks and the parsed credentials from memory, and writes no state: a
cancelled wizard is indistinguishable from one that was never opened. A selection
that is reviewed but never acted on expires after fifteen minutes, and everything
is released when the window closes.

Migration can be re-run from Settings. Re-running **can create duplicate
bookmarks**, and the wizard says so rather than letting the user discover it
afterwards. Deduplication is on by default and is conservative: a bookmark counts
as already saved only when its normalised address *and* its folder path match.
Normalisation lowercases the scheme and host, drops a fragment, and keeps the
query string — for many sites the query selects the page, so treating `?id=1` and
`?id=2` as one bookmark would silently discard something the user saved. The same
page filed under two folders stays two bookmarks, because filing it twice was two
deliberate acts.

Skipped records are reported as counts on the result screen.

## Residual risks

- **An exported CSV is a plaintext file of your passwords.** OpenStrawberry reads
  it, never copies it, and tells you to delete it — but it cannot delete it for
  you, and it cannot know whether your exporter left a copy elsewhere. The native
  dialog is opened with `dontAddToRecent` so the choice does not land in the
  operating system's recent-documents list.
- **Encryption is only as strong as the platform's.** `safeStorage` binds to the
  Keychain, DPAPI, or a Linux keyring. Anyone who can already run code as you can
  generally ask the same OS to decrypt.
- **Bookmark titles and addresses come from another program.** They are bounded
  and stripped of control characters and bidirectional overrides before being
  stored, but they remain data the user once saved, not data OpenStrawberry
  vouches for.
- **Detection is a fixed list.** A browser installed somewhere unusual, or a
  portable install, is not found. That is a deliberate consequence of not
  searching the filesystem, and the manual export path covers it.
- **Not audited.** No third party has reviewed this code. See
  [`SECURITY.md`](SECURITY.md).

## Where the code is

| Concern | File |
|---|---|
| Types, limits, validators, IPC payload parsers | [`src/shared/migration.ts`](../src/shared/migration.ts) |
| Read-only browser detection | [`src/main/migration-sources.ts`](../src/main/migration-sources.ts) |
| Chromium JSON, search name, and HTML parsers | [`src/main/bookmark-parsers.ts`](../src/main/bookmark-parsers.ts) |
| Password CSV reader | [`src/main/password-csv.ts`](../src/main/password-csv.ts) |
| Bookmark store, password vault, migration state | [`src/main/migration-store.ts`](../src/main/migration-store.ts) |
| Runtime: handles, dialogs, commit, lifecycle | [`src/main/migration-manager.ts`](../src/main/migration-manager.ts) |
| Capability contract | [`src/shared/bridge.ts`](../src/shared/bridge.ts) |
| Wizard state machine | [`src/renderer/migration-wizard.ts`](../src/renderer/migration-wizard.ts) |
| Wizard UI | [`src/renderer/MigrationWizard.tsx`](../src/renderer/MigrationWizard.tsx) |
