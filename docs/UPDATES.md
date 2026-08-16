# In-app updates

OpenStrawberry uses its public **GitHub Releases** page as its intended update source. The desktop update controller checks the configured release metadata from the main process, presents the available version and release notes, downloads only after the user chooses **Download update**, and exposes **Restart and install** only after the package has finished downloading. The renderer never receives updater configuration credentials, installer paths, or raw updater errors.

## Release safety gate

The repository currently sets `openstrawberryUpdateChannel.enabled` to `false`. This makes update checks intentionally unavailable in development builds, unsigned packages, and all artifacts produced before the first signed stable release. The interface explains this state instead of presenting an untrusted download path.

Before enabling the channel for a stable release, maintainers must complete the platform-specific release requirements already documented in [`RELEASES.md`](RELEASES.md): a notarized Developer ID macOS build, an Authenticode-signed Windows build, and verified Linux artifacts with release checksums. The release must include the Electron Builder update metadata alongside the matching installer assets.

> Do not enable the channel for smoke builds, drafts, prereleases, or unsigned installers. An update notification is a release-integrity promise, not a generic download prompt.

## User experience

| Update state | User-facing behavior |
|---|---|
| Release channel unavailable | The Updates panel explains that updates start after the first signed release; it performs no network check. |
| Checking | The panel reports the active check without exposing transport details. |
| Available | The version and release notes are shown; downloading requires the user’s explicit action. |
| Downloading | Progress is displayed in the panel. |
| Downloaded | The user can restart OpenStrawberry and let the platform updater install the update. |
| Error | A privacy-preserving retry message is shown; raw endpoint and updater errors remain in the main process. |

The Electron Builder targets already use update-capable installer formats: macOS DMG, Windows NSIS, and Linux AppImage/DEB/RPM. Platform signing and a signed stable GitHub Release remain mandatory before the update channel is enabled.
