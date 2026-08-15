# Installation and release strategy

OpenStrawberry is designed to install like a familiar desktop browser. The package configuration currently defines these target artifacts:

| Platform | Release artifact | Intended user experience |
|---|---|---|
| macOS | Universal DMG | Open image, drag OpenStrawberry to Applications, then open normally |
| Windows | Per-user NSIS EXE | Double-click installer, choose shortcut options, launch from Start menu |
| Linux | AppImage, DEB, RPM | AppImage for portable launch; DEB/RPM for distribution-native installation |

## Local test build

```bash
pnpm install
pnpm package:dir
```

This produces an unpacked local application appropriate for development validation. Full platform installers are built with `pnpm package` on the target platform or an appropriate release runner.

## Production release requirements

Production macOS builds must be Developer ID signed and notarized. Production Windows builds require Authenticode signing. Linux release artifacts must publish versioned checksums and package/repository signing guidance. Update feeds are enabled only after signed artifacts and manifest verification are configured.

The development package metadata uses a placeholder open-source maintainer address so Linux package generation can be exercised in CI. A verified release-maintainer address, platform signing identities, notarization credentials, and signed update feed must be configured before any public binary release.

First launch remains fully usable without an account, migration, agent configuration, telemetry, or default-browser selection. The user can choose each of those later in Settings.
