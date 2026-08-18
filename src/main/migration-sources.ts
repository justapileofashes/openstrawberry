/**
 * Read-only detection of Chromium-family browsers already on this machine.
 *
 * Three rules shape this module:
 *
 *   1. **The registry is a fixed list.** Detection looks at the profile roots
 *      named below for the current platform and nowhere else. It does not walk
 *      the home directory, does not search for browsers, and cannot be pointed
 *      somewhere by anything the renderer sends.
 *   2. **Detection never opens a bookmark file.** It checks that a profile
 *      exists and that the files it *would* read are present, and reads one
 *      display-name index. What is in those files stays unread until the user
 *      has picked a source and a profile.
 *   3. **Profile identifiers are minted here.** The renderer never learns a
 *      directory name and never sends one. It sends an id this module issued,
 *      which is resolved back to a location through a map only the trusted
 *      process holds. An id that was not issued resolves to nothing.
 *
 * Firefox and Safari are deliberately absent. Their bookmarks live in
 * `places.sqlite` and a binary property list, both of which are locked while the
 * browser runs and neither of which OpenStrawberry will open. Those families
 * come in through a file the user exports and picks.
 */

import {
  MAX_DETECTED_BROWSERS,
  MAX_PROFILES_PER_BROWSER,
  type DetectedBrowser,
  type DetectedProfile
} from "../shared/migration.js";

/** The `Local State` index is small; this is generous and still bounded. */
export const MAX_LOCAL_STATE_BYTES = 4 * 1024 * 1024;

/** Bounds a profile display name read out of another browser's index. */
const MAX_PROFILE_NAME_LENGTH = 64;

/**
 * The filesystem, as detection needs it.
 *
 * Injected rather than imported so the whole registry is testable against a
 * fixture tree, and so nothing here can reach for `node:fs` directly.
 */
export interface DetectionPort {
  readonly exists: (path: string) => boolean;
  readonly readDirectory: (path: string) => readonly string[];
  readonly readTextFile: (path: string, maxBytes: number) => string | null;
  readonly join: (...parts: readonly string[]) => string;
}

/** One entry in the fixed registry: a browser and where its profiles live. */
export interface SourceCandidate {
  readonly id: string;
  readonly displayName: string;
  readonly userDataDir: string;
}

/** A profile id resolved back to the two files a migration may read. */
export interface ResolvedProfile {
  readonly browserId: string;
  readonly profileId: string;
  readonly bookmarksPath: string | null;
  readonly preferencesPath: string | null;
}

export interface DetectionResult {
  /** Safe to send to the renderer: names and capability flags only. */
  readonly browsers: readonly DetectedBrowser[];
  /** Trusted-process only. Keyed by `browserId/profileId`. */
  readonly resolved: ReadonlyMap<string, ResolvedProfile>;
}

export function profileKey(browserId: string, profileId: string): string {
  return `${browserId}/${profileId}`;
}

/* ------------------------------------------------------------------------- */
/* The registry                                                               */
/* ------------------------------------------------------------------------- */

interface RegistryEntry {
  readonly id: string;
  readonly displayName: string;
  /** Path segments below the platform's base directory. */
  readonly segments: readonly string[];
  /** Which base directory the segments hang off. */
  readonly base: "local-app-data" | "roaming-app-data" | "home";
}

const WINDOWS_REGISTRY: readonly RegistryEntry[] = [
  { id: "google-chrome", displayName: "Google Chrome", base: "local-app-data", segments: ["Google", "Chrome", "User Data"] },
  { id: "microsoft-edge", displayName: "Microsoft Edge", base: "local-app-data", segments: ["Microsoft", "Edge", "User Data"] },
  { id: "brave", displayName: "Brave", base: "local-app-data", segments: ["BraveSoftware", "Brave-Browser", "User Data"] },
  { id: "vivaldi", displayName: "Vivaldi", base: "local-app-data", segments: ["Vivaldi", "User Data"] },
  { id: "chromium", displayName: "Chromium", base: "local-app-data", segments: ["Chromium", "User Data"] },
  { id: "opera", displayName: "Opera", base: "roaming-app-data", segments: ["Opera Software", "Opera Stable"] }
];

const MACOS_REGISTRY: readonly RegistryEntry[] = [
  { id: "google-chrome", displayName: "Google Chrome", base: "home", segments: ["Library", "Application Support", "Google", "Chrome"] },
  { id: "microsoft-edge", displayName: "Microsoft Edge", base: "home", segments: ["Library", "Application Support", "Microsoft Edge"] },
  { id: "brave", displayName: "Brave", base: "home", segments: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"] },
  { id: "vivaldi", displayName: "Vivaldi", base: "home", segments: ["Library", "Application Support", "Vivaldi"] },
  { id: "chromium", displayName: "Chromium", base: "home", segments: ["Library", "Application Support", "Chromium"] },
  { id: "opera", displayName: "Opera", base: "home", segments: ["Library", "Application Support", "com.operasoftware.Opera"] }
];

const LINUX_REGISTRY: readonly RegistryEntry[] = [
  { id: "google-chrome", displayName: "Google Chrome", base: "home", segments: [".config", "google-chrome"] },
  { id: "microsoft-edge", displayName: "Microsoft Edge", base: "home", segments: [".config", "microsoft-edge"] },
  { id: "brave", displayName: "Brave", base: "home", segments: [".config", "BraveSoftware", "Brave-Browser"] },
  { id: "vivaldi", displayName: "Vivaldi", base: "home", segments: [".config", "vivaldi"] },
  { id: "chromium", displayName: "Chromium", base: "home", segments: [".config", "chromium"] },
  { id: "opera", displayName: "Opera", base: "home", segments: [".config", "opera"] }
];

export interface RegistryEnvironment {
  readonly platform: string;
  readonly homeDir: string;
  /** `%LOCALAPPDATA%`. Empty off Windows. */
  readonly localAppData: string;
  /** `%APPDATA%`. Empty off Windows. */
  readonly roamingAppData: string;
}

/**
 * The candidate list for this platform.
 *
 * A candidate whose base directory is unknown is dropped rather than being
 * resolved against a guess, because a guessed base is how a path traversal
 * starts.
 */
export function sourceCandidates(
  environment: RegistryEnvironment,
  port: Pick<DetectionPort, "join">
): readonly SourceCandidate[] {
  const registry =
    environment.platform === "win32"
      ? WINDOWS_REGISTRY
      : environment.platform === "darwin"
        ? MACOS_REGISTRY
        : environment.platform === "linux"
          ? LINUX_REGISTRY
          : [];

  const candidates: SourceCandidate[] = [];

  for (const entry of registry) {
    const base =
      entry.base === "home"
        ? environment.homeDir
        : entry.base === "local-app-data"
          ? environment.localAppData
          : environment.roamingAppData;

    if (base.length === 0) continue;

    candidates.push({
      id: entry.id,
      displayName: entry.displayName,
      userDataDir: port.join(base, ...entry.segments)
    });

    if (candidates.length >= MAX_DETECTED_BROWSERS) break;
  }

  return candidates;
}

/* ------------------------------------------------------------------------- */
/* Profile discovery                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The profile directory names Chromium creates.
 *
 * An allowlist, not a filter: `Guest Profile` and `System Profile` are not
 * a user's saved bookmarks, and anything else in the user-data directory is
 * cache, crash dumps, or component data that migration has no interest in.
 */
const PROFILE_DIRECTORY = /^(?:Default|Profile \d{1,3})$/u;

/** Turns a directory name into an identifier the IPC validator accepts. */
function profileIdFor(directoryName: string): string {
  return directoryName.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
}

function boundName(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > MAX_PROFILE_NAME_LENGTH
    ? cleaned.slice(0, MAX_PROFILE_NAME_LENGTH)
    : cleaned;
}

/**
 * Display names another Chromium browser has already chosen for its profiles.
 *
 * `Local State` also carries sign-in state, hosted-app data, variation seeds,
 * and device identifiers. Only `name` is read, and only for directories that
 * passed the allowlist above.
 */
function readProfileNames(
  userDataDir: string,
  port: DetectionPort
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();

  const text = port.readTextFile(port.join(userDataDir, "Local State"), MAX_LOCAL_STATE_BYTES);
  if (text === null) return names;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch {
    return names;
  }

  if (typeof parsed !== "object" || parsed === null) return names;
  const profile = (parsed as Record<string, unknown>)["profile"];
  if (typeof profile !== "object" || profile === null) return names;

  const cache = (profile as Record<string, unknown>)["info_cache"];
  if (typeof cache !== "object" || cache === null) return names;

  for (const [directory, value] of Object.entries(cache as Record<string, unknown>)) {
    if (!PROFILE_DIRECTORY.test(directory)) continue;
    if (typeof value !== "object" || value === null) continue;

    const name = boundName((value as Record<string, unknown>)["name"]);
    if (name.length > 0) names.set(directory, name);
  }

  return names;
}

/**
 * The profile directories inside one browser's user-data directory.
 *
 * Opera keeps a single profile at the root of its directory rather than in a
 * `Default` subdirectory, so a root that itself holds a `Bookmarks` file counts
 * as one profile. That is why the returned directory name can be empty.
 */
function profileDirectories(userDataDir: string, port: DetectionPort): readonly string[] {
  const directories: string[] = [];

  if (port.exists(port.join(userDataDir, "Bookmarks"))) directories.push("");

  for (const entry of port.readDirectory(userDataDir)) {
    if (!PROFILE_DIRECTORY.test(entry)) continue;
    directories.push(entry);
    if (directories.length >= MAX_PROFILES_PER_BROWSER) break;
  }

  return directories;
}

/**
 * Inspects the registry and reports what is actually present.
 *
 * A missing root, an unreadable directory, a locked index, and a browser that
 * was never installed are all the same ordinary outcome: that candidate simply
 * does not appear. None of them is an error the user has to resolve.
 */
export function detectBrowsers(
  candidates: readonly SourceCandidate[],
  port: DetectionPort
): DetectionResult {
  const browsers: DetectedBrowser[] = [];
  const resolved = new Map<string, ResolvedProfile>();

  for (const candidate of candidates) {
    if (!port.exists(candidate.userDataDir)) continue;

    const names = readProfileNames(candidate.userDataDir, port);
    const profiles: DetectedProfile[] = [];
    const seen = new Set<string>();

    for (const directory of profileDirectories(candidate.userDataDir, port)) {
      const profileDir =
        directory.length === 0 ? candidate.userDataDir : port.join(candidate.userDataDir, directory);

      const bookmarksPath = port.join(profileDir, "Bookmarks");
      const preferencesPath = port.join(profileDir, "Preferences");
      const hasBookmarks = port.exists(bookmarksPath);
      const hasPreferences = port.exists(preferencesPath);

      // A directory offering neither is not a profile worth showing.
      if (!hasBookmarks && !hasPreferences) continue;

      const profileId = directory.length === 0 ? "default" : profileIdFor(directory);
      if (profileId.length === 0 || seen.has(profileId)) continue;
      seen.add(profileId);

      profiles.push({
        id: profileId,
        displayName: names.get(directory) ?? (directory.length === 0 ? "Default" : directory),
        supportsBookmarkRead: hasBookmarks,
        supportsSearchNameRead: hasPreferences
      });

      resolved.set(profileKey(candidate.id, profileId), {
        browserId: candidate.id,
        profileId,
        bookmarksPath: hasBookmarks ? bookmarksPath : null,
        preferencesPath: hasPreferences ? preferencesPath : null
      });
    }

    if (profiles.length === 0) continue;

    browsers.push({
      id: candidate.id,
      displayName: candidate.displayName,
      family: "chromium",
      profiles
    });
  }

  return { browsers, resolved };
}
