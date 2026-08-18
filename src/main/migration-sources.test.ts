import { describe, expect, it } from "vitest";
import {
  detectBrowsers,
  profileKey,
  sourceCandidates,
  type DetectionPort,
  type RegistryEnvironment
} from "./migration-sources.js";

/** A fake tree. Directories are keys ending in `/`; files map to their contents. */
function portFor(tree: Readonly<Record<string, string>>): DetectionPort {
  const join = (...parts: readonly string[]): string =>
    parts.filter((part) => part.length > 0).join("/");

  return {
    join,
    exists: (path) => tree[path] !== undefined || tree[`${path}/`] !== undefined,
    readDirectory: (path) => {
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        // Only directories, matching the real port's `withFileTypes` filter.
        const separator = rest.indexOf("/");
        if (separator > 0) names.add(rest.slice(0, separator));
      }
      return [...names];
    },
    readTextFile: (path) => tree[path] ?? null
  };
}

const WINDOWS: RegistryEnvironment = {
  platform: "win32",
  homeDir: "C:/Users/person",
  localAppData: "C:/Users/person/AppData/Local",
  roamingAppData: "C:/Users/person/AppData/Roaming"
};

const LINUX: RegistryEnvironment = {
  platform: "linux",
  homeDir: "/home/person",
  localAppData: "",
  roamingAppData: ""
};

const CHROME_LINUX = "/home/person/.config/google-chrome";

describe("sourceCandidates", () => {
  it("returns only the allowlisted Chromium-family browsers", () => {
    const ids = sourceCandidates(WINDOWS, portFor({})).map((candidate) => candidate.id);

    expect(ids).toEqual([
      "google-chrome",
      "microsoft-edge",
      "brave",
      "vivaldi",
      "chromium",
      "opera"
    ]);
  });

  it("never offers Firefox or Safari as a detected source", () => {
    for (const environment of [WINDOWS, LINUX, { ...LINUX, platform: "darwin" }]) {
      const ids = sourceCandidates(environment, portFor({})).map((candidate) => candidate.id);
      expect(ids).not.toContain("firefox");
      expect(ids).not.toContain("safari");
    }
  });

  it("resolves each candidate under the platform's own base directory", () => {
    const windows = sourceCandidates(WINDOWS, portFor({}));
    for (const candidate of windows) {
      expect(
        candidate.userDataDir.startsWith("C:/Users/person/AppData/Local") ||
          candidate.userDataDir.startsWith("C:/Users/person/AppData/Roaming")
      ).toBe(true);
    }

    const linux = sourceCandidates(LINUX, portFor({}));
    for (const candidate of linux) {
      expect(candidate.userDataDir.startsWith("/home/person/.config")).toBe(true);
    }
  });

  it("drops a candidate whose base directory is unknown rather than guessing", () => {
    // No %LOCALAPPDATA%: every Windows candidate that hangs off it disappears.
    const candidates = sourceCandidates(
      { ...WINDOWS, localAppData: "", roamingAppData: "" },
      portFor({})
    );
    expect(candidates).toEqual([]);
  });

  it("returns nothing for a platform with no registry", () => {
    expect(sourceCandidates({ ...LINUX, platform: "aix" }, portFor({}))).toEqual([]);
  });
});

describe("detectBrowsers", () => {
  it("reports nothing when no profile root exists", () => {
    const result = detectBrowsers(sourceCandidates(LINUX, portFor({})), portFor({}));

    expect(result.browsers).toEqual([]);
    expect(result.resolved.size).toBe(0);
  });

  it("finds profiles and mints identifiers that are not directory names", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Local State`]: JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" }, "Profile 1": { name: "Work" } } }
      }),
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}",
      [`${CHROME_LINUX}/Default/Preferences`]: "{}",
      [`${CHROME_LINUX}/Profile 1/Bookmarks`]: "{}"
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);

    expect(result.browsers).toHaveLength(1);
    const chrome = result.browsers[0];
    expect(chrome?.id).toBe("google-chrome");
    expect(chrome?.family).toBe("chromium");
    expect(chrome?.profiles).toEqual([
      {
        id: "default",
        displayName: "Personal",
        supportsBookmarkRead: true,
        supportsSearchNameRead: true
      },
      {
        id: "profile-1",
        displayName: "Work",
        supportsBookmarkRead: true,
        supportsSearchNameRead: false
      }
    ]);

    // The identifier is safe to send over IPC; the directory name is not.
    for (const profile of chrome?.profiles ?? []) {
      expect(profile.id).toMatch(/^[a-z0-9-]+$/u);
      expect(profile.id).not.toContain(" ");
    }
  });

  it("resolves an id back to a path only inside the trusted result", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}",
      [`${CHROME_LINUX}/Default/Preferences`]: "{}"
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);

    expect(result.resolved.get(profileKey("google-chrome", "default"))).toEqual({
      browserId: "google-chrome",
      profileId: "default",
      bookmarksPath: `${CHROME_LINUX}/Default/Bookmarks`,
      preferencesPath: `${CHROME_LINUX}/Default/Preferences`
    });

    // Nothing the renderer receives carries a location.
    expect(JSON.stringify(result.browsers)).not.toContain("/home/person");
  });

  it("refuses to resolve an identifier it did not mint", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}"
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);

    for (const key of [
      profileKey("google-chrome", "profile-9"),
      profileKey("firefox", "default"),
      profileKey("../../etc", "passwd"),
      "google-chrome/Default"
    ]) {
      expect(result.resolved.get(key)).toBeUndefined();
    }
  });

  it("ignores directories that are not user profiles", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}",
      [`${CHROME_LINUX}/Guest Profile/Bookmarks`]: "{}",
      [`${CHROME_LINUX}/System Profile/Bookmarks`]: "{}",
      [`${CHROME_LINUX}/ShaderCache/x`]: "",
      [`${CHROME_LINUX}/Crashpad/y`]: ""
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);

    expect(result.browsers[0]?.profiles.map((profile) => profile.id)).toEqual(["default"]);
  });

  it("skips a profile directory offering neither file", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Default/Cache/x`]: "",
      [`${CHROME_LINUX}/Profile 1/Bookmarks`]: "{}"
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);

    expect(result.browsers[0]?.profiles.map((profile) => profile.id)).toEqual(["profile-1"]);
  });

  it("omits a browser whose root exists but holds no readable profile", () => {
    const port = portFor({ [`${CHROME_LINUX}/`]: "", [`${CHROME_LINUX}/Cache/x`]: "" });
    expect(detectBrowsers(sourceCandidates(LINUX, port), port).browsers).toEqual([]);
  });

  it("falls back to the directory name when the display index is unreadable", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Local State`]: "{ not json",
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}"
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);
    expect(result.browsers[0]?.profiles[0]?.displayName).toBe("Default");
  });

  it("reads only the profile name out of the display index", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Local State`]: JSON.stringify({
        profile: {
          info_cache: {
            Default: {
              name: "Personal",
              gaia_id: "1234567890",
              user_name: "person@example.com",
              hosted_domain: "example.com"
            }
          }
        },
        variations_seed_signature: "abc"
      }),
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}"
    });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);
    const serialized = JSON.stringify(result.browsers);

    expect(result.browsers[0]?.profiles[0]?.displayName).toBe("Personal");
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("1234567890");
    expect(serialized).not.toContain("example.com");
  });

  it("bounds and cleans a hostile profile name", () => {
    const port = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Local State`]: JSON.stringify({
        profile: { info_cache: { Default: { name: `${"x".repeat(500)}\u202Eevil\u0007` } } }
      }),
      [`${CHROME_LINUX}/Default/Bookmarks`]: "{}"
    });

    const name = detectBrowsers(sourceCandidates(LINUX, port), port).browsers[0]?.profiles[0]
      ?.displayName;

    expect(name?.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/[\u0000-\u001F\u202A-\u202E]/u);
  });

  it("treats a root holding bookmarks directly as one profile, as Opera does", () => {
    const opera = "/home/person/.config/opera";
    const port = portFor({ [`${opera}/`]: "", [`${opera}/Bookmarks`]: "{}" });

    const result = detectBrowsers(sourceCandidates(LINUX, port), port);

    expect(result.browsers).toHaveLength(1);
    expect(result.browsers[0]?.id).toBe("opera");
    expect(result.browsers[0]?.profiles[0]?.id).toBe("default");
  });

  it("never opens a bookmark file during detection", () => {
    const opened: string[] = [];
    const base = portFor({
      [`${CHROME_LINUX}/`]: "",
      [`${CHROME_LINUX}/Default/Bookmarks`]: '{"roots":{}}',
      [`${CHROME_LINUX}/Default/Preferences`]: "{}"
    });

    const watched: DetectionPort = {
      ...base,
      readTextFile: (path, maxBytes) => {
        opened.push(path);
        return base.readTextFile(path, maxBytes);
      }
    };

    detectBrowsers(sourceCandidates(LINUX, watched), watched);

    // Only the display-name index is read. Bookmarks and preferences stay shut
    // until a user names this profile.
    for (const path of opened) expect(path.endsWith("Local State")).toBe(true);
  });
});
