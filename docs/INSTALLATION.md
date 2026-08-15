# Installation and release strategy

OpenStrawberry is designed to install like a familiar desktop browser. The package configuration currently defines these target artifacts:

| Platform | Release artifact | Intended user experience |
|---|---|---|
| macOS | Universal DMG | Open image, drag OpenStrawberry to Applications, then open normally |
| Windows | Per-user NSIS EXE | Double-click installer, choose shortcut options, launch from Start menu |
| Linux | AppImage, DEB, RPM | AppImage for portable launch; DEB/RPM for distribution-native installation |

## GitHub Releases downloads

The canonical installer page is [GitHub Releases](https://github.com/justapileofashes/openstrawberry/releases). The repository does **not** currently offer a signed public installer. When a stable release is published, users should download assets only from that page, select their platform-specific installer, and verify the attached `SHA256SUMS.txt` before installation.

Do not treat files shared through forks, pull requests, issue comments, chat messages, or third-party mirrors as official OpenStrawberry installers. The current Linux build is a developer smoke-test artifact and is intentionally not attached to a GitHub Release.

See [`RELEASES.md`](RELEASES.md) for the future asset names, verification commands, and signing expectations.

> **Desktop-app experience:** Stable installers are intended to be opened from the graphical desktop once. After that, OpenStrawberry launches from standard OS surfaces—Windows Start/taskbar, macOS Applications/Spotlight/Dock, or a Linux app launcher—without running terminal commands.

## Local test build

```bash
pnpm install
pnpm package:dir
```

This produces an unpacked local application appropriate for development validation. Full platform installers are built with `pnpm package` on the target platform or an appropriate release runner.

> **Validated on Linux:** the unpacked `linux-unpacked` application and a native DEB package build both completed successfully for version `0.1.0`. The Linux package uses the OpenStrawberry PNG icon and matching desktop-entry naming. The successful DEB artifact is a smoke-test result only; it is not signed or published.

## Production release requirements

Production macOS builds must be Developer ID signed and notarized. Production Windows builds require Authenticode signing. Linux release artifacts must publish versioned checksums and package/repository signing guidance. Update feeds are enabled only after signed artifacts and manifest verification are configured. AppImage/RPM and macOS/Windows installer generation must be revalidated on their intended release runners.

The development package metadata uses a placeholder open-source maintainer address so Linux package generation can be exercised in CI. A verified release-maintainer address, platform signing identities, notarization credentials, and signed update feed must be configured before any public binary release.

First launch remains fully usable without an account, migration, agent configuration, telemetry, or default-browser selection. The user can choose each of those later in Settings.
