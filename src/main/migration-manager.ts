/* Migration manager: profile discovery is metadata-only. Browser password databases are never read; a user-selected CSV is staged only after explicit native confirmation. */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, extname, join } from "node:path";
import { extractChromiumBookmarks, extractChromiumDefaultSearch, extractHtmlBookmarks, type BookmarkExportImportResult, type BookmarkExportPreview, type BrowserId, type BrowserMigrationCandidate, type MigrationImportResult, type MigratedBookmark, type OnboardingState, type PasswordExportImportResult, type PasswordExportPreview } from "../shared/migration.js";

type SourceDefinition = { id: BrowserId; label: string; sourceDirectory: string; kind: "chromium" | "firefox" | "safari" };
const MAX_BOOKMARK_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PREFERENCES_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PASSWORD_EXPORT_BYTES = 5 * 1024 * 1024;
const MAX_PASSWORD_EXPORT_ENTRIES = 10_000;
const MAX_PASSWORD_FIELD_LENGTH = 8_192;
const MAX_USERNAME_LENGTH = 1_024;

export type PasswordEncryptor = { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer };
type PendingPasswordImport = { browser: BrowserId; fileName: string; entries: PasswordExportEntry[]; createdAt: number };
type PendingBookmarkImport = { browser: BrowserId; fileName: string; bookmarks: MigratedBookmark[]; createdAt: number };
type PasswordExportEntry = { url: string; username: string; password: string };
type StoredPasswordExport = { version: 1; imports: { browser: BrowserId; fileName: string; importedAt: number; entries: { url: string; username: string; password: string }[] }[] };
type StoredBookmarkExport = { version: 1; imports: { browser: BrowserId; fileName: string; importedAt: number; bookmarks: MigratedBookmark[] }[] };

export class MigrationManager {
  private readonly pendingPasswordImports = new Map<string, PendingPasswordImport>();
  private readonly pendingBookmarkImports = new Map<string, PendingBookmarkImport>();

  public constructor(private readonly userDataPath: string, private readonly passwordEncryptor?: PasswordEncryptor) {}

  public getOnboardingState(): OnboardingState {
    try { return JSON.parse(this.readRegularUtf8File(join(this.userDataPath, "onboarding.json"), 64 * 1024)) as OnboardingState; } catch { return { completed: false }; }
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
    const bookmarks = extractChromiumBookmarks(this.readRegularUtf8File(bookmarkPath, MAX_BOOKMARK_FILE_BYTES));
    const preferencesPath = join(profileDirectory, "Preferences");
    const defaultSearchProvider = existsSync(preferencesPath) ? extractChromiumDefaultSearch(this.readRegularUtf8File(preferencesPath, MAX_PREFERENCES_FILE_BYTES)) : undefined;
    this.write("migrated-browser-data.json", { source: source.id, importedAt: Date.now(), bookmarks, ...(defaultSearchProvider ? { defaultSearchProvider } : {}) });
    return { browser: source.id, bookmarksImported: bookmarks.length, defaultSearchProvider, note: "Bookmarks and the displayed default-search name were copied into OpenStrawberry-owned local storage. Passwords, sessions, cookies, payment data, and history were not read." };
  }

  public prepareBookmarkExport(browser: BrowserId, filePath: string): BookmarkExportPreview {
    const extension = extname(filePath).toLowerCase();
    if (extension !== ".html" && extension !== ".htm") throw new Error("Choose a browser-exported HTML bookmarks file.");
    const bookmarks = extractHtmlBookmarks(this.readRegularUtf8File(filePath, MAX_BOOKMARK_FILE_BYTES));
    if (bookmarks.length === 0) throw new Error("No compatible web bookmarks were found in this HTML export.");
    const importId = randomUUID();
    const fileName = basename(filePath).slice(0, 160);
    this.pendingBookmarkImports.set(importId, { browser, fileName, bookmarks, createdAt: Date.now() });
    this.prunePendingImports();
    return { importId, browser, fileName, bookmarksFound: bookmarks.length, note: "OpenStrawberry read this user-selected HTML export only to prepare this review. No browser profile database, history, cookie, session, password, or account-token file was opened." };
  }

  public commitBookmarkExport(importId: string): BookmarkExportImportResult {
    const pending = this.pendingBookmarkImports.get(importId);
    if (!pending) throw new Error("This bookmark-import review has expired. Select the HTML export again to prepare a new review.");
    const storage = this.readOwnJson<StoredBookmarkExport>("manual-bookmark-imports.json", { version: 1, imports: [] });
    storage.imports.push({ browser: pending.browser, fileName: pending.fileName, importedAt: Date.now(), bookmarks: pending.bookmarks });
    this.write("manual-bookmark-imports.json", storage);
    this.pendingBookmarkImports.delete(importId);
    return { browser: pending.browser, bookmarksImported: pending.bookmarks.length, note: "The reviewed HTML bookmarks were copied to OpenStrawberry-owned local storage. Passwords, cookies, sessions, payment data, account tokens, and history were not imported." };
  }

  public discardBookmarkExport(importId: string): void { this.pendingBookmarkImports.delete(importId); }

  public preparePasswordExport(browser: BrowserId, filePath: string): PasswordExportPreview {
    if (!this.passwordEncryptor?.isEncryptionAvailable()) throw new Error("Secure operating-system encryption is unavailable, so password exports cannot be imported.");
    if (extname(filePath).toLowerCase() !== ".csv") throw new Error("Choose a browser-generated .csv password export.");
    const entries = parsePasswordExportCsv(this.readRegularUtf8File(filePath, MAX_PASSWORD_EXPORT_BYTES));
    if (entries.length === 0) throw new Error("No compatible password entries were found in this CSV export.");
    const importId = randomUUID();
    const fileName = basename(filePath).slice(0, 160);
    this.pendingPasswordImports.set(importId, { browser, fileName, entries, createdAt: Date.now() });
    this.prunePendingPasswordImports();
    return {
      importId,
      browser,
      fileName,
      entriesFound: entries.length,
      distinctSites: new Set(entries.map((entry) => new URL(entry.url).origin)).size,
      note: "OpenStrawberry read this user-selected CSV only to prepare this review. Password values were not sent to the interface, a provider, or a website.",
    };
  }

  public commitPasswordExport(importId: string): PasswordExportImportResult {
    const pending = this.pendingPasswordImports.get(importId);
    if (!pending) throw new Error("This password-import review has expired. Select the CSV again to prepare a new review.");
    if (!this.passwordEncryptor?.isEncryptionAvailable()) throw new Error("Secure operating-system encryption is unavailable, so password exports cannot be imported.");
    const encryptedEntries = pending.entries.map((entry) => ({ ...entry, password: this.passwordEncryptor!.encryptString(entry.password).toString("base64") }));
    const storage = this.readOwnJson<StoredPasswordExport>("migrated-password-exports.json", { version: 1, imports: [] });
    storage.imports.push({ browser: pending.browser, fileName: pending.fileName, importedAt: Date.now(), entries: encryptedEntries });
    this.write("migrated-password-exports.json", storage);
    this.pendingPasswordImports.delete(importId);
    return {
      browser: pending.browser,
      entriesImported: encryptedEntries.length,
      distinctSites: new Set(encryptedEntries.map((entry) => new URL(entry.url).origin)).size,
      note: "The reviewed CSV entries were encrypted with operating-system-backed protection in OpenStrawberry-owned local storage. This release stages them only; it does not expose, autofill, sync, or send passwords to websites.",
    };
  }

  public discardPasswordExport(importId: string): void { this.pendingPasswordImports.delete(importId); }
  public discardAllPendingPasswordExports(): void { this.pendingPasswordImports.clear(); }
  public discardAllPendingBookmarkExports(): void { this.pendingBookmarkImports.clear(); }

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
    return candidates.map((name) => join(sourceDirectory, name)).filter((path) => { try { const entry = lstatSync(path); return entry.isDirectory() && !entry.isSymbolicLink(); } catch { return false; } });
  }

  private write(fileName: string, value: unknown): void {
    mkdirSync(this.userDataPath, { recursive: true, mode: 0o700 });
    try { chmodSync(this.userDataPath, 0o700); } catch { /* Best-effort on platforms without POSIX modes. */ }
    const target = join(this.userDataPath, fileName);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    try { chmodSync(target, 0o600); } catch { /* Best-effort on platforms without POSIX modes. */ }
  }
  private readOwnJson<T>(fileName: string, fallback: T): T {
    const file = join(this.userDataPath, fileName);
    try { return JSON.parse(this.readRegularUtf8File(file, MAX_PASSWORD_EXPORT_BYTES * 32)) as T; } catch { return fallback; }
  }
  private prunePendingPasswordImports(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, pending] of this.pendingPasswordImports) if (pending.createdAt < cutoff) this.pendingPasswordImports.delete(id);
  }
  private prunePendingImports(): void {
    this.prunePendingPasswordImports();
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, pending] of this.pendingBookmarkImports) if (pending.createdAt < cutoff) this.pendingBookmarkImports.delete(id);
  }
  private readRegularUtf8File(file: string, maxBytes: number): string {
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Refusing a non-regular migration file.");
    if (statSync(file).size > maxBytes) throw new Error("Migration file exceeds the safety limit.");
    return readFileSync(file, "utf8");
  }
}

export function parsePasswordExportCsv(serialized: string): PasswordExportEntry[] {
  const rows = parseBoundedCsv(serialized);
  const headers = rows.shift()?.map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
  if (!headers) throw new Error("The password export is missing a CSV header row.");
  const urlColumn = findColumn(headers, ["url", "origin", "site"]);
  const usernameColumn = findColumn(headers, ["username", "user name", "login"]);
  const passwordColumn = findColumn(headers, ["password", "pass"]);
  if (urlColumn === -1 || usernameColumn === -1 || passwordColumn === -1) throw new Error("The CSV must include URL, username, and password columns from a supported browser export.");
  const entries: PasswordExportEntry[] = [];
  for (const row of rows) {
    if (entries.length >= MAX_PASSWORD_EXPORT_ENTRIES) break;
    const url = row[urlColumn]?.trim() ?? "";
    const username = row[usernameColumn]?.trim() ?? "";
    const password = row[passwordColumn] ?? "";
    if (!isSafePasswordUrl(url) || username.length > MAX_USERNAME_LENGTH || !password || password.length > MAX_PASSWORD_FIELD_LENGTH) continue;
    entries.push({ url, username, password });
  }
  return entries;
}

function findColumn(headers: string[], candidates: string[]): number { return headers.findIndex((header) => candidates.includes(header)); }
function isSafePasswordUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }

function parseBoundedCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const pushField = () => { if (field.length > MAX_PASSWORD_FIELD_LENGTH) throw new Error("A password-export field exceeds the safety limit."); row.push(field); field = ""; };
  const pushRow = () => { pushField(); if (row.some((value) => value.length > 0)) rows.push(row); row = []; if (rows.length > MAX_PASSWORD_EXPORT_ENTRIES + 1) throw new Error("The password export has too many entries."); };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index += 1; continue; }
      if (character === '"') { quoted = false; continue; }
      field += character;
      continue;
    }
    if (character === '"') { if (field) throw new Error("Malformed quoted CSV field."); quoted = true; continue; }
    if (character === ",") { pushField(); continue; }
    if (character === "\n") { pushRow(); continue; }
    if (character === "\r") { if (input[index + 1] === "\n") index += 1; pushRow(); continue; }
    field += character;
  }
  if (quoted) throw new Error("Malformed CSV: an unterminated quoted field was found.");
  if (field || row.length) pushRow();
  return rows;
}
