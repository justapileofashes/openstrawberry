# GitHub Releases and installer downloads

## Canonical download location

OpenStrawberry installers will be published only through the repository’s [GitHub Releases page](https://github.com/justapileofashes/openstrawberry/releases). A latest-release shortcut will become available at `https://github.com/justapileofashes/openstrawberry/releases/latest` once the first signed stable release exists.

> **Current availability:** no signed public installers have been released. Do not download or install the repository’s private Linux smoke-build output. It exists solely to validate Electron Builder configuration.

## Choose an installer

| Your platform | Release asset | Install path |
|---|---|---|
| macOS (Apple Silicon or Intel) | `OpenStrawberry-<version>-mac-universal.dmg` | Open the disk image, drag OpenStrawberry to Applications, then open the app normally. |
| Windows 10/11 x64 | `OpenStrawberry-<version>-win-x64.exe` | Run the signed NSIS installer; it installs per user and provides Start menu/desktop options. |
| Linux, portable | `OpenStrawberry-<version>-linux-x86_64.AppImage` | Mark the file executable, then launch it. |
| Debian/Ubuntu Linux | `OpenStrawberry-<version>-linux-amd64.deb` | Install with your distribution package manager. |
| Fedora/RHEL/openSUSE Linux | `OpenStrawberry-<version>-linux-x86_64.rpm` | Install with your distribution package manager. |

## No-terminal installation and launch

OpenStrawberry’s release experience is installer-first. Users should download one release file, open it with their normal graphical desktop, complete the installer, and then use the operating system’s normal app entry points. No terminal, package-manager command, or developer setup is required for a stable release.

| Platform | One-time graphical install | Everyday launch |
|---|---|---|
| macOS | Double-click the signed DMG, then drag OpenStrawberry to Applications. macOS will verify the notarized app on first open. | Use Spotlight, Launchpad, Applications, Dock, or a pinned Dock icon. |
| Windows | Double-click the signed `.exe` installer and accept the default per-user installation. The installer creates Start menu and desktop shortcuts. | Search **OpenStrawberry** from Start, select its Start-menu entry, or pin it to the taskbar. |
| Debian/Ubuntu Linux | Double-click the signed `.deb` in the system software installer and select Install. | Search **OpenStrawberry** in the desktop app launcher, add it to favorites, or launch from its menu entry. |
| Fedora/RHEL/openSUSE Linux | Double-click the signed `.rpm` in the system software installer and select Install. | Search **OpenStrawberry** in the desktop app launcher, add it to favorites, or launch from its menu entry. |
| Portable Linux | Open the signed AppImage through the graphical file manager; desktop integration depends on the user’s distribution/AppImage integration. | Prefer the DEB or RPM whenever an app-launcher entry is important. |

The Windows package is deliberately per-user and uses the stable native application identity `io.openstrawberry.browser`, so its Start menu, desktop shortcut, and taskbar pin refer to the same app installation rather than a temporary download path.

## Verify a release download

Every stable release will attach `SHA256SUMS.txt` beside its installers. Download the installer and checksum file from the **same** GitHub Release, then verify the named asset before opening it.

### macOS and Linux

```bash
shasum -a 256 -c SHA256SUMS.txt
```

On Linux, `sha256sum -c SHA256SUMS.txt` is also supported.

### Windows PowerShell

```powershell
Get-FileHash .\OpenStrawberry-<version>-win-x64.exe -Algorithm SHA256
```

Compare the displayed hash against the corresponding line in `SHA256SUMS.txt` from the same release.

## Release trust requirements

| Platform | Required trust signal before public publication |
|---|---|
| macOS | Developer ID signature and Apple notarization |
| Windows | Authenticode signature from the OpenStrawberry publisher identity |
| Linux | Attached SHA-256 checksums and package/repository signing guidance |
| All assets | Versioned GitHub Release notes, immutable asset names, and a checksum file generated from the uploaded artifacts |

If a platform’s signing requirement is not complete, that installer will not be presented as a stable OpenStrawberry download.

## Maintainer release process

The packaging build emits installers into the ignored `release/` directory. Before an asset is attached to a GitHub Release, run:

```bash
pnpm package
pnpm release:verify
```

The verification step produces `release/SHA256SUMS.txt` for eligible installer artifacts. It is a packaging integrity check, not a substitute for macOS notarization, Windows Authenticode, or a secure release runner.

Use the release checklist in [`INSTALLATION.md`](INSTALLATION.md) and [`RELEASE_DISTRIBUTION_NOTES.md`](RELEASE_DISTRIBUTION_NOTES.md) before drafting or publishing any GitHub Release.
