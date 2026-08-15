import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationManager, parsePasswordExportCsv, type PasswordEncryptor } from "./migration-manager.js";

const directories: string[] = [];
const testEncryptor: PasswordEncryptor = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`sealed:${value}`, "utf8") };

function temporaryDirectory(): string { const directory = mkdtempSync(join(tmpdir(), "openstrawberry-migration-")); directories.push(directory); return directory; }
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

describe("password-export migration", () => {
  it("parses only compatible web entries and keeps values out of preview metadata", () => {
    const entries = parsePasswordExportCsv("name,url,username,password,note\nGitHub,https://github.com,octo,correct horse battery staple,\nLocal,file:///private,not-imported,secret,\n");
    expect(entries).toEqual([{ url: "https://github.com", username: "octo", password: "correct horse battery staple" }]);
  });

  it("stages a selected CSV in memory, then stores only encrypted password values after explicit commit", () => {
    const directory = temporaryDirectory();
    const exportPath = join(directory, "chrome-passwords.csv");
    writeFileSync(exportPath, "url,username,password\nhttps://example.com,alice,private-password\n", "utf8");
    const manager = new MigrationManager(directory, testEncryptor);

    const preview = manager.preparePasswordExport("chrome", exportPath);
    expect(preview).toMatchObject({ browser: "chrome", fileName: "chrome-passwords.csv", entriesFound: 1, distinctSites: 1 });
    expect(JSON.stringify(preview)).not.toContain("private-password");

    const result = manager.commitPasswordExport(preview.importId);
    const persisted = readFileSync(join(directory, "migrated-password-exports.json"), "utf8");
    expect(result.entriesImported).toBe(1);
    expect(persisted).not.toContain("private-password");
    expect(persisted).toContain(Buffer.from("sealed:private-password", "utf8").toString("base64"));
  });

  it("rejects non-CSV and does not create an import review when OS encryption is unavailable", () => {
    const directory = temporaryDirectory();
    const exportPath = join(directory, "passwords.txt");
    writeFileSync(exportPath, "url,username,password\nhttps://example.com,alice,secret\n", "utf8");
    const manager = new MigrationManager(directory, { isEncryptionAvailable: () => false, encryptString: testEncryptor.encryptString });

    expect(() => manager.preparePasswordExport("firefox", exportPath)).toThrow("Secure operating-system encryption is unavailable");
  });
});
