# Releases

**There is no stable release. What is published is an unsigned prerelease.**

OpenStrawberry is an active development build. The current published version is
**v0.1.1-alpha.1**: five installers, built and verified on their own runners,
and **not signed or notarised**. They may be presented as a prerelease download
— which the README does — and may never be presented as a stable one. No
artifact produced from this repository today carries a signature.

The narrow path that lets an unsigned build be published at all is described in
[Unsigned prereleases](#unsigned-prereleases). It is not the signing gate
opening.

## Artifacts

These names are fixed so packaging, release tooling, and
[`src/shared/desktop-shell.ts`](../src/shared/desktop-shell.ts) agree on them.

| Platform | Artifact | State at v0.1.1-alpha.1 |
|---|---|---|
| macOS | `OpenStrawberry-mac-universal.dmg` | Published, unsigned |
| Windows | `OpenStrawberry-win-x64.exe` | Published, unsigned |
| Linux | `OpenStrawberry-linux-x86_64.AppImage` | Published, unsigned |
| Linux | `OpenStrawberry-linux-amd64.deb` | Published, unsigned |
| Linux | `OpenStrawberry-linux-x86_64.rpm` | Published, unsigned |

A release publishes more than these five; the updater's half of it —
`latest*.yml`, the mac ZIP, and the blockmaps — is listed in
[`UPDATES.md`](UPDATES.md). `SHA256SUMS.txt` and a `provenance-*.json` per
runner are published alongside.

The Windows target is a one-click, per-user NSIS installer.
`allowToChangeInstallationDirectory` stays disabled.

## Release gate

A **stable** release may not be announced until **all** of the following are
complete. A prerelease is the one documented exception, and it is described
below.

- [ ] Windows Authenticode signing — *enforced, awaiting a certificate*
- [ ] macOS Developer ID signing and notarisation — *enforced, awaiting a certificate*
- [x] Linux artifacts built and verified on a Linux runner — *run at v0.1.1-alpha.1*
- [x] macOS DMG built and verified on a native macOS runner — *run at v0.1.1-alpha.1*
- [x] SHA-256 checksums published for every artifact
- [x] Release provenance recorded

The two boxes now ticked are narrower than they look. They say the artifact was
produced and verified on its own platform's runner — present, non-empty,
correctly named, checksum-matching. They do not say anyone has installed or
launched it there; see [Current platform validation](#current-platform-validation).

`RELEASE_READY` in [`src/shared/desktop-shell.ts`](../src/shared/desktop-shell.ts)
is **not** the in-code expression of this gate, and the difference matters. It
asserts that published artifacts and update metadata exist for a build to talk
to — true since v0.1.0-alpha.1 — and it says nothing about signing. The two are
tracked separately on purpose: conflating them is how an unsigned update ships
while a boolean claims otherwise. The signing rows above are the signing claim,
and they are still open.

## How the gate is enforced

The gate is not kept by whoever remembers to read this page. Four scripts hold
it, and `pnpm release` chains them:

| Step | Script | What it refuses |
|---|---|---|
| `pnpm verify:config` | `scripts/verify-config.mjs` | A packaging option the installed electron-builder does not recognise, on any platform — including the ones the current host cannot build; and an installer script that has stopped registering the app with Windows, writes to a registry root a per-user install cannot reach, or leaves a key behind on uninstall |
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
| Windows NSIS artifact | Built on a Windows runner and **unsigned**; published as a prerelease. Not installed by anyone here |
| Windows application registration | Compiled into the installer, checked by `pnpm verify:config`, and read back after a real install — the keys land. What it still does not achieve is listed below |
| Packaged renderer CSP | Verified in `dist/renderer/index.html` and again from inside the asar of `release/win-unpacked`: production policy, no source maps |
| Linux AppImage / DEB / RPM | Built and verified on `ubuntu-latest` at v0.1.1-alpha.1. **Not launched** on a Linux desktop; the desktop entry, `StartupWMClass`, and icon set are unexercised |
| macOS DMG and ZIP | Built and verified on `macos-latest` at v0.1.1-alpha.1. **Not launched** on macOS, and unsigned, so Gatekeeper will refuse it without an explicit override |

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

### Windows application registration

Add/Remove Programs was never the gap. electron-builder writes that entry, so
Settings > Apps > Installed apps has always listed OpenStrawberry. What was
missing is a separate set of keys — the ones that make Windows treat the app as
an application it *knows about*. Without them the app had no ProgID for an
association to name, was not registered as a web browser at all, and was unknown
to the Run dialog.

[`resources/installer.nsh`](../resources/installer.nsh) writes four
registrations, all to `SHELL_CONTEXT` so a per-user install reaches them without
elevation. Each is load-bearing on its own:

| Key | What it buys |
|---|---|
| `Software\Classes\OpenStrawberryHTML` | The ProgID an association points *at*. An association with no ProgID to name has nothing to record |
| `Software\Clients\StartMenuInternet\OpenStrawberry` | Classifies the app as a web browser rather than a program that happens to accept a URL. Only clients listed here are offered under "Web browser" |
| `Software\RegisteredApplications` | The index Windows reads to find the Capabilities key |
| `App Paths\OpenStrawberry.exe` | `start openstrawberry` and the Run dialog resolve the executable without a full path |

`http` and `https` are claimed together — the same pair `DEFAULT_BROWSER_PROTOCOLS`
names, and they must stay in step. The document types are claimed to match
`LOCAL_DOCUMENT_EXTENSIONS`, and `pnpm verify:config` fails the release if those
two lists drift: an extension registered here that the app will not render means
someone picks OpenStrawberry for their `.html` files and gets an empty tab on
every double-click.

The legacy `InstallInfo` subkey is deliberately not written. Chrome, Firefox, and
every Chromium fork write it, so it was tested by hand — it changed nothing, and
its commands are switches this application does not implement.

The ProgID name is fixed forever. Windows seals the person's default-browser
choice against it with a hash an installer cannot forge, so renaming the ProgID
silently unsets their default months later.

The uninstaller removes all four — but only on a real uninstall. An update runs
the old uninstaller before the new installer rewrites everything, and tearing
the registration down in between is pointless when the update succeeds and
harmful when it does not.

#### What this does not yet achieve

**OpenStrawberry still does not appear in Settings > Default apps.** Measured on
Windows 11 build 26200, with every key below present and correct:

| Checked | Result |
|---|---|
| All four registrations, read back after a real install | Present, correct values |
| `AssocQueryStringW` on the ProgID | Resolves to the executable, friendly name, and open command |
| `shell:AppsFolder` | Lists OpenStrawberry under AUMID `io.openstrawberry.browser` |
| `start openstrawberry` via App Paths | Launches |
| Settings > Default apps, searched for the app | *"We couldn't find anything to show here"* |

Two hypotheses were tested and both were wrong: adding the `InstallInfo` subkey
changed nothing, and neither did adding file associations. The registration now
matches a working per-user Chromium browser on the same machine key-for-key and
Windows still will not list it. The remaining untested explanation is that the
list is built from a per-user index that rebuilds at sign-in, which no amount of
`SHChangeNotify` reaches.

Nothing above is wasted — the ProgID, the browser client entry, and App Paths are
each independently required and independently verified. But the headline claim is
not yet earned, and this section will say so until it is.

Cross-platform packaging is not validated by building on one host. Each target
is confirmed on its own runner before any claim of readiness.

## Unsigned prereleases

The gate above describes a *stable* release. A prerelease has to be able to
exist before any certificate does, or the three-platform build path is first
exercised on the day it matters most.

So there is one way past the signing requirement, and it is deliberately narrow:

- The build reads `OPENSTRAWBERRY_ALLOW_UNSIGNED`. It is never a default and is
  never inferred from a missing credential — something has to set it.
- The only thing that sets it is
  [`.github/workflows/release.yml`](../.github/workflows/release.yml), and only
  for a tag carrying a prerelease suffix — `v0.1.0-alpha.1`, never `v1.0.0`.
  The tag is the authorisation, so an unsigned build cannot be produced under a
  name that reads as stable.
- It downgrades **signature verdicts only**. A missing, empty, misnamed, or
  checksum-mismatched artifact still fails the run, and `pnpm verify:artifacts`
  still prints every artifact as unsigned in plain words.
- The resulting GitHub release is marked as a prerelease and opens with what it
  is: unsigned, unnotarised, warned about by SmartScreen and Gatekeeper, with
  the checksums as its only integrity claim.

A prerelease is not the signing gate opening, and nothing above is a substitute
for a certificate. The in-app updater now runs against these artifacts — see
[`UPDATES.md`](UPDATES.md), particularly what an unsigned channel does not give
you.

## Download buttons

The per-OS buttons live in [`README.md`](../README.md), on the repository
landing page. They are plain links to release assets — the visitor picks their
platform by clicking it.

They point at an explicit tag — `v0.1.1-alpha.1` today — not
`releases/latest/download/...`. That path resolves only to the newest *stable*
release, so while the current build is a prerelease it would 404, which is the
rule below. The cost is that the links name a version and must be updated when a
new one is published; the benefit is that they are never a link to a file that is
not there. **Publishing a new prerelease means editing five links and a table in
[`README.md`](../README.md).**

## Rules

- Never commit a built binary.
- Never link `releases/latest/download/...` while it would 404 or resolve to an
  unsigned file.
- Never describe a locally built installer as a stable download.
- Do not silently install a built EXE in order to test it. Launch the unpacked
  application instead.
