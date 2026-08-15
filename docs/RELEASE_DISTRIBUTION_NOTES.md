# Release Distribution Notes

## Reference pattern reviewed

BrowserOS makes downloads easy to discover by placing platform-specific installer links near the top of its repository README and maintaining a visible GitHub Releases surface. Its release assets expose a per-file SHA-256 digest in GitHub’s release UI.[1] [2]

OpenStrawberry will adopt the **discovery pattern**, not the branding, copy, assets, or distribution infrastructure. The public repository should provide one obvious **Download OpenStrawberry** link to GitHub Releases, a platform matrix, versioned release notes, and SHA-256 verification guidance.

## OpenStrawberry security rule

OpenStrawberry must not publish its current unsigned Linux smoke-build artifact as a trusted installer. The repository will show that GitHub Releases is the single future installer destination, while clearly stating that verified downloads begin only after platform signing and provenance controls are available.

Each published stable release must contain the following release assets where applicable:

| Platform | User-facing asset | Trust requirement |
|---|---|---|
| macOS | `OpenStrawberry-mac-universal.dmg` | Developer ID signing and Apple notarization |
| Windows | `OpenStrawberry-win-x64.exe` | Authenticode signing |
| Linux | `OpenStrawberry-linux-x86_64.AppImage`, `OpenStrawberry-linux-amd64.deb`, and `OpenStrawberry-linux-x86_64.rpm` | SHA-256 checksums and repository/package signing guidance |
| All platforms | `SHA256SUMS.txt` | Generated from the exact uploaded artifacts and attached to the same GitHub Release |

## References

[1] [BrowserOS repository](https://github.com/browseros-ai/BrowserOS)

[2] [BrowserOS Releases](https://github.com/browseros-ai/BrowserOS/releases)
