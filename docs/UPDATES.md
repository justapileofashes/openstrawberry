# Updates

The in-app updater is **on**, against GitHub Releases, since v0.1.0-alpha.1, and
has run against a real `electron-updater` transport since v0.1.1-alpha.1.

It updates to unsigned prereleases, because that is what is published. Read
[what that costs](#what-an-unsigned-channel-does-not-give-you) before assuming
the channel is as safe as a signed one; the rest of this page describes a design
that was built for signed artifacts and is running ahead of them.

## States

The update panel surfaces exactly these states:

| State | Meaning |
|---|---|
| `disabled` | No verified update channel. Reachable in any unpackaged build. |
| `checking` | A user-initiated check is in flight. |
| `available` | A newer version exists. Nothing has been downloaded, and nothing about it is signed. |
| `downloading` | The user explicitly started a download. Progress is visible. |
| `downloaded` | The update is staged and waiting for an explicit restart. |
| `error` | The check or download failed. The message is redacted. |

## Rules

- **Never silently download.** Availability is surfaced; the download is a
  separate, explicit user action.
- **Never silently install.** A staged update installs on an explicit restart,
  so the user never has to manually redownload an installer.
- **Never activate on the presence of an artifact alone.** The channel requires
  both a packaged build and verified release metadata.

## Activation gate

Updates require all three of these, and the conjunction is the safety property —
no single edit turns downloading-and-running-code on:

1. `app.isPackaged` — a development build never updates itself,
2. `RELEASE_READY` — published artifacts and metadata exist to talk to,
3. `openstrawberryUpdateChannel.enabled` in `package.json`, mirrored by
   `UPDATE_CHANNEL_ENABLED` — the maintainer's intent to publish updates at all.

All three now hold in a packaged build. `updateGate` returns *why* it refused
rather than a boolean, so the chrome can say something true when one does not.

## How it is wired

Two files, split so that the part deciding *whether* an update may happen never
depends on the part that performs it:

| File | Responsibility |
|---|---|
| [`src/main/update-transport.ts`](../src/main/update-transport.ts) | The only importer of `electron-updater`. Turns its event-emitting singleton into a narrow interface, with `autoDownload` and `autoInstallOnAppQuit` both off |
| [`src/main/update-manager.ts`](../src/main/update-manager.ts) | The gate, the state machine, and the refusals. Holds a transport at arm's length and validates everything arriving from one |

Consequences worth the indirection:

- A build that must not update **never loads the updater at all**. The transport
  is constructed only after the gate has already opened, so the refusal is the
  updater not existing rather than a branch inside it.
- A manager with no transport refuses with `metadata-invalid` rather than
  crashing, so a build that has not wired one is honest rather than broken.
- Every inbound handler **re-asks the gate**. A transport is an event source
  that outlives the command that started it, so "the gate was open when the user
  pressed check" is not the same claim as "the gate is open now".
- Every value crossing inward is parsed, not read. A version arrives from a
  release server and is about to be shown to a person, so `parseVersion` bounds
  its length and alphabet; a version that fails to parse is a metadata error.
  The server's own error text never reaches the chrome — it is logged at the
  transport and dropped, and the panel gets a code.

The feed is not configured in code. electron-builder writes `app-update.yml`
into the package from the `publish` block in `package.json`; setting a URL as
well would create a second place for the channel to be wrong.

## What a release must publish

Installers alone are not a release the updater can read:

| File | Why |
|---|---|
| `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | The metadata `electron-updater` reads to learn a version exists |
| `OpenStrawberry-mac-universal.zip` | Squirrel.Mac can only apply an update delivered as a ZIP. A mac channel with only a DMG points at a file it cannot install |
| `*.blockmap` | Lets a Windows update fetch a delta rather than the whole installer |

`allowPrerelease` is on. While the published artifacts are prereleases, a channel
that accepted only stable versions would find nothing and report the build as up
to date.

## What an unsigned channel does not give you

The published artifacts are an unsigned prerelease, and an updater is the most
dangerous feature a desktop application has — it downloads code and runs it.

- **Windows.** Updates install without a signature to verify. The integrity
  claim is HTTPS to GitHub plus the SHA-512 in `latest.yml`, which establishes
  that the file arrived intact from that release — not who produced it.
- **macOS.** Squirrel.Mac requires a valid code signature to apply an update at
  all. An unsigned mac build will find an update, download it, and fail to
  install it. This is Apple refusing, not a bug here.
- **Linux.** AppImage updates in place; `.deb` and `.rpm` do not self-update and
  are managed by the system package manager.

None of this is fixed by the updater. It is fixed by the signing gate in
[`RELEASES.md`](RELEASES.md), which is still open.
