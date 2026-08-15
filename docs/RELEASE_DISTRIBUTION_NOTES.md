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

## Validation record

On **2026-08-15**, the project’s network-capable Linux validation produced the configured unsigned AppImage, DEB, and RPM assets. The DEB and RPM metadata reported the expected package name, architecture, maintainer, homepage, and local-first browser description, and `pnpm release:verify` generated SHA-256 sums from the produced files. A Windows x64 directory package and a macOS x64 `.app` directory package also completed with the configured native icons. These checks verify packaging prerequisites only; none of these artifacts was uploaded or presented as a public download.

The configured universal macOS merge must run on macOS because Electron’s universal-packaging implementation is Darwin-only. The DMG, Windows NSIS installer, macOS signing/notarization, Windows Authenticode signing, and signed-release publication remain release-runner work, as specified above.

## References

[1] [BrowserOS repository](https://github.com/browseros-ai/BrowserOS)

[2] [BrowserOS Releases](https://github.com/browseros-ai/BrowserOS/releases)
