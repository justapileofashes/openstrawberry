export const DESKTOP_APP_ID = "io.openstrawberry.browser";
export const DESKTOP_APP_NAME = "OpenStrawberry";

export const RELEASE_ASSETS = {
  macos: "OpenStrawberry-mac-universal.dmg",
  windows: "OpenStrawberry-win-x64.exe",
  linuxAppImage: "OpenStrawberry-linux-x86_64.AppImage",
  linuxDeb: "OpenStrawberry-linux-amd64.deb",
  linuxRpm: "OpenStrawberry-linux-x86_64.rpm",
  checksums: "SHA256SUMS.txt",
} as const;

export function latestReleaseDownloadUrl(assetName: string): string {
  return `https://github.com/justapileofashes/openstrawberry/releases/latest/download/${assetName}`;
}
