# Updates

The in-app updater is **disabled**, by design, and stays disabled until signed
release artifacts and verified update metadata exist.

## States

The update panel surfaces exactly these states:

| State | Meaning |
|---|---|
| `disabled` | No verified update channel. The current and only reachable state. |
| `checking` | A user-initiated check is in flight. |
| `available` | A newer signed version exists. Nothing has been downloaded. |
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

Updates become available only when both conditions hold:

1. `app.isPackaged` is true, and
2. the release metadata in `package.json` under `openstrawberryUpdateChannel`
   is verified and its `enabled` flag is set.

The flag is currently `false`. Flipping it without completing the release gate
in [`RELEASES.md`](RELEASES.md) would point users at unsigned binaries, which is
precisely the failure this design exists to prevent.

The intended source is GitHub Releases via `electron-updater`.
