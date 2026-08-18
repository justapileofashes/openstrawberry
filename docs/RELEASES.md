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

- [ ] Windows Authenticode signing — *enforced, awaiting a certificate*
- [ ] macOS Developer ID signing and notarisation — *enforced, awaiting a certificate*
- [ ] Linux artifact verification on a Linux runner — *automated, not yet run*
- [ ] macOS DMG validated on a native macOS runner — *automated, not yet run*
- [x] SHA-256 checksums published for every artifact
- [x] Release provenance recorded

`RELEASE_READY` in [`src/shared/desktop-shell.ts`](../src/shared/desktop-shell.ts)
is the in-code expression of this gate. It must only change alongside real
signing and verified metadata.

## How the gate is enforced

The gate is not kept by whoever remembers to read this page. Three scripts hold
it, and `pnpm release` chains them:

| Step | Script | What it refuses |
|---|---|---|
| `pnpm release:preflight` | `scripts/release-preflight.mjs` | Starting a release build on a host that cannot sign, naming the missing credential |
| `pnpm checksums` | `scripts/checksums.mjs` | — writes `SHA256SUMS.txt` and `provenance.json` |
| `pnpm verify:artifacts` | `scripts/verify-artifacts.mjs` | A missing, empty, unsigned, un-notarised, or checksum-mismatched artifact |

`pnpm package` is unchanged and still produces an unsigned local build. Testing
a build you cannot distribute is normal; only the distribution path is gated.

Running the verifier against the current unsigned local build fails, which is
the correct result:

```
FAIL  release\OpenStrawberry-win-x64.exe: Authenticode status is NotSigned, not Valid
1 check(s) failed. These artifacts must not be distributed.
```

## Signing credentials

Supplied as CI secrets or local environment variables. None is stored in the
repository, and the preflight names whichever is absent.

| Platform | Variables | Notes |
|---|---|---|
| Windows | `CSC_LINK`, `CSC_KEY_PASSWORD` | Path or base64 of the `.pfx`, and its password |
| Windows (alternative) | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CODE_SIGNING_NAME`, `AZURE_CERT_PROFILE_NAME` | Azure Trusted Signing instead of a certificate file |
| macOS signing | `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID Application certificate |
| macOS notarisation | `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key, preferred |
| macOS notarisation (alternative) | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Must be an app-specific password, never the account password |

macOS builds use the hardened runtime with
[`resources/entitlements.mac.plist`](../resources/entitlements.mac.plist), which
grants only the three entitlements a Chromium browser cannot run without.

## Release workflow

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on a
`v*` tag. It builds Windows, macOS, and Linux on their own runners, runs the
full gate on each, re-verifies every checksum after the artifacts are collected,
and opens a **draft** release.

It never publishes. `GH_TOKEN` is explicitly cleared so electron-builder cannot
upload on its own, `make_latest` is false, and the draft is left for a person to
review and release deliberately.

## Current platform validation

Honest status, not aspiration:

| Target | State |
|---|---|
| Windows unpacked launch and clean exit | Validated on Windows 11: launches, holds its window, hands off a second launch to the single-instance lock, exits cleanly with no orphaned processes |
| Windows NSIS artifact | Built locally and **unsigned**; not installed or published. The verifier refuses it |
| Packaged renderer CSP | Verified in `dist/renderer/index.html`: production policy, no source maps |
| Linux AppImage / DEB / RPM | Not yet built; requires a Linux runner |
| macOS DMG | Not yet built; requires a native macOS runner |

electron-builder logs `signing with signtool.exe` while packaging on Windows
even when no certificate is configured. That line does not mean the artifact is
signed. Confirm with:

```bash
powershell -c "(Get-AuthenticodeSignature 'release/OpenStrawberry-win-x64.exe').Status"
```

The current local build reports `NotSigned`.

## Desktop identity

The app is registered as its own application rather than an anonymous Electron
host:

- `app.setAppUserModelId` is set to the `appId` before any window exists, which
  is what drives Windows taskbar grouping, the Start-menu entry, and pinning.
  It must stay equal to the ID electron-builder stamps on the installed
  shortcut, or pinning silently splits into two entries.
- The Windows executable is `OpenStrawberry.exe`, so the process carries the
  product name.
- A single-instance lock keeps one taskbar button; a second launch hands its
  arguments to the running instance and exits.
- Linux ships a desktop entry with `StartupWMClass` matched to the executable
  name via `syncDesktopName`, plus `Keywords` so the app is searchable.

**Start-menu search requires installation.** A built or unpacked binary is not
indexed; Windows resolves search from installed shortcuts. Running the NSIS
installer creates the Start-menu and desktop shortcuts that make the app
searchable and pinnable.

Cross-platform packaging is not validated by building on one host. Each target
is confirmed on its own runner before any claim of readiness.

## Rules

- Never commit a built binary.
- Never link `releases/latest/download/...` while it would 404 or resolve to an
  unsigned file.
- Never describe a locally built installer as a stable download.
- Do not silently install a built EXE in order to test it. Launch the unpacked
  application instead.
