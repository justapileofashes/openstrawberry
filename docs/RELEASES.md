# Releases

**There is no stable release, and there are no public downloads.**

OpenStrawberry is an active development build. No artifact produced from this
repository today is signed, notarised, or verified, and none may be presented as
a public download.

## Planned artifacts

These names are documented so packaging and release tooling agree on them.
Naming an artifact here does not mean it exists or is signed.

| Platform | Planned artifact |
|---|---|
| macOS | `OpenStrawberry-mac-universal.dmg` |
| Windows | `OpenStrawberry-win-x64.exe` |
| Linux | `OpenStrawberry-linux-x86_64.AppImage` |
| Linux | `OpenStrawberry-linux-amd64.deb` |
| Linux | `OpenStrawberry-linux-x86_64.rpm` |

The Windows target is a one-click, per-user NSIS installer.
`allowToChangeInstallationDirectory` stays disabled.

## Release gate

A release may not be announced, and download affordances may not be enabled,
until **all** of the following are complete:

- [ ] Windows Authenticode signing
- [ ] macOS Developer ID signing and notarisation
- [ ] Linux artifact verification on a Linux runner
- [ ] macOS DMG validated on a native macOS runner
- [ ] SHA-256 checksums published for every artifact
- [ ] Release provenance recorded

`RELEASE_READY` in [`src/shared/desktop-shell.ts`](../src/shared/desktop-shell.ts)
is the in-code expression of this gate. It must only change alongside real
signing and verified metadata.

## Current platform validation

Honest status, not aspiration:

| Target | State |
|---|---|
| Windows unpacked launch and clean exit | Validated on Windows 11 |
| Windows NSIS artifact | Not yet built |
| Linux AppImage / DEB / RPM | Not yet built; requires a Linux runner |
| macOS DMG | Not yet built; requires a native macOS runner |

Cross-platform packaging is not validated by building on one host. Each target
is confirmed on its own runner before any claim of readiness.

## Rules

- Never commit a built binary.
- Never link `releases/latest/download/...` while it would 404 or resolve to an
  unsigned file.
- Never describe a locally built installer as a stable download.
- Do not silently install a built EXE in order to test it. Launch the unpacked
  application instead.
