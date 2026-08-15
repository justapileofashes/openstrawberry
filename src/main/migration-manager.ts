/* Migration manager: profile discovery is metadata-only. Reads begin only after a user selects a browser import, and never access cookies, session tokens, payment data, or password databases. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { extractChromiumBookmarks, extractChromiumDefaultSearch, type BrowserId, type BrowserMigrationCandidate, type MigrationImportResult, type OnboardingState } from "../shared/migration.js";

type SourceDefinition = { id: BrowserId; label: string; sourceDirectory: string; kind: "chromium" | "firefox" | "safari" };

export class MigrationManager {
  public constructor(private readonly userDataPath: string) {}

  public getOnboardingState(): OnboardingState {
    try { return JSON.parse(readFileSync(join(this.userDataPath, "onboarding.json"), "utf8")) as OnboardingState; } catch { return { completed: false }; }
  }

  public completeOnboarding(importedBrowser?: BrowserId): OnboardingState {
    const state: OnboardingState = { completed: true, ...(importedBrowser ? { importedBrowser, importedAt: Date.now() } : {}) };
    this.write("onboarding.json", state);
    return state;
  }

  public detectBrowsers(): BrowserMigrationCandidate[] {
    return this.sourceDefinitions().map((source) => {
      const detected = existsSync(source.sourceDirectory);
      const profileCount = source.kind === "chromium" ? this.chromiumProfiles(source.sourceDirectory).length : detected ? 1 : 0;
      return { id: source.id, label: source.label, detected, profileCount, bookmarkImport: source.kind === "chromium" ? "supported" : "export-file-required", settingsImport: source.kind === "chromium" ? "supported" : "export-file-required" };
    });
  }

  public importBrowser(browserId: BrowserId): MigrationImportResult {
    const source = this.sourceDefinitions().find((candidate) => candidate.id === browserId);
    if (!source || !existsSync(source.sourceDirectory)) throw new Error("That browser profile was not detected on this device.");
    if (source.kind !== "chromium") throw new Error(`${source.label} requires a user-exported bookmark file in this release; no protected browser profile data was read.`);
    const profileDirectory = this.chromiumProfiles(source.sourceDirectory)[0];
    if (!profileDirectory) throw new Error("No compatible Chromium browser profile was found.");
    const bookmarkPath = join(profileDirectory, "Bookmarks");
    if (!existsSync(bookmarkPath)) throw new Error("This browser profile does not contain a readable bookmark file.");
    const bookmarks = extractChromiumBookmarks(readFileSync(bookmarkPath, "utf8"));
    const preferencesPath = join(profileDirectory, "Preferences");
    const defaultSearchProvider = existsSync(preferencesPath) ? extractChromiumDefaultSearch(readFileSync(preferencesPath, "utf8")) : undefined;
    this.write("migrated-browser-data.json", { source: source.id, importedAt: Date.now(), bookmarks, ...(defaultSearchProvider ? { defaultSearchProvider } : {}) });
    return { browser: source.id, bookmarksImported: bookmarks.length, defaultSearchProvider, note: "Bookmarks and the displayed default-search name were copied into OpenStrawberry-owned local storage. Passwords, sessions, cookies, payment data, and history were not read." };
  }

  private sourceDefinitions(): SourceDefinition[] {
    const home = homedir();
    if (platform() === "win32") {
      const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      const roaming = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return [{ id: "chrome", label: "Google Chrome", sourceDirectory: join(local, "Google", "Chrome", "User Data"), kind: "chromium" }, { id: "edge", label: "Microsoft Edge", sourceDirectory: join(local, "Microsoft", "Edge", "User Data"), kind: "chromium" }, { id: "brave", label: "Brave", sourceDirectory: join(local, "BraveSoftware", "Brave-Browser", "User Data"), kind: "chromium" }, { id: "firefox", label: "Firefox", sourceDirectory: join(roaming, "Mozilla", "Firefox"), kind: "firefox" }];
    }
    if (platform() === "darwin") return [{ id: "chrome", label: "Google Chrome", sourceDirectory: join(home, "Library", "Application Support", "Google", "Chrome"), kind: "chromium" }, { id: "edge", label: "Microsoft Edge", sourceDirectory: join(home, "Library", "Application Support", "Microsoft Edge"), kind: "chromium" }, { id: "brave", label: "Brave", sourceDirectory: join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"), kind: "chromium" }, { id: "firefox", label: "Firefox", sourceDirectory: join(home, "Library", "Application Support", "Firefox"), kind: "firefox" }, { id: "safari", label: "Safari", sourceDirectory: join(home, "Library", "Safari"), kind: "safari" }];
    return [{ id: "chrome", label: "Google Chrome", sourceDirectory: join(home, ".config", "google-chrome"), kind: "chromium" }, { id: "edge", label: "Microsoft Edge", sourceDirectory: join(home, ".config", "microsoft-edge"), kind: "chromium" }, { id: "brave", label: "Brave", sourceDirectory: join(home, ".config", "BraveSoftware", "Brave-Browser"), kind: "chromium" }, { id: "firefox", label: "Firefox", sourceDirectory: join(home, ".mozilla", "firefox"), kind: "firefox" }];
  }

  private chromiumProfiles(sourceDirectory: string): string[] {
    const candidates = ["Default", ...Array.from({ length: 20 }, (_unused, index) => `Profile ${index + 1}`)];
    return candidates.map((name) => join(sourceDirectory, name)).filter((path) => existsSync(path));
  }

  private write(fileName: string, value: unknown): void {
    mkdirSync(this.userDataPath, { recursive: true });
    writeFileSync(join(this.userDataPath, fileName), JSON.stringify(value, null, 2), "utf8");
  }
}
