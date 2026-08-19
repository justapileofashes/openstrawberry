import { describe, expect, it } from "vitest";
import { parsePasswordCsv } from "./password-csv.js";
import { MAX_CSV_ROWS, type MigrationWarningCode } from "../shared/migration.js";

function codes(warnings: readonly { readonly code: MigrationWarningCode }[]): string[] {
  return warnings.map((warning) => warning.code);
}

describe("parsePasswordCsv", () => {
  it("reads the Chromium export layout", () => {
    const { records, preview } = parsePasswordCsv(
      [
        "name,url,username,password",
        "Example,https://example.com/,alice,hunter2",
        "Other,https://other.test/login,bob,s3cret"
      ].join("\n")
    );

    expect(records).toEqual([
      { url: "https://example.com/", username: "alice", password: "hunter2" },
      { url: "https://other.test/login", username: "bob", password: "s3cret" }
    ]);
    expect(preview.totalRows).toBe(2);
    expect(preview.validRows).toBe(2);
    expect(preview.rejectedRows).toBe(0);
    expect(preview.detectedColumns).toEqual(["name", "url", "username", "password"]);
  });

  it("accepts the common column aliases", () => {
    const bitwarden = parsePasswordCsv(
      "folder,login_uri,login_username,login_password\nx,https://a.test/,alice,pw"
    );
    expect(bitwarden.records).toHaveLength(1);

    const onePassword = parsePasswordCsv("Title,Website,Login Name,Password\nx,https://b.test/,bob,pw");
    expect(onePassword.records[0]).toEqual({
      url: "https://b.test/",
      username: "bob",
      password: "pw"
    });

    const origin = parsePasswordCsv("origin,email,pass\nhttps://c.test/,c@d.test,pw");
    expect(origin.records[0]?.username).toBe("c@d.test");
  });

  it("keeps every value out of the preview", () => {
    const { preview } = parsePasswordCsv(
      "url,username,password\nhttps://example.com/,alice,SuperSecret123"
    );

    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain("SuperSecret123");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("example.com");
  });

  it("reports no column names when the first row is not a header", () => {
    // A headerless export would otherwise render a live credential as a label.
    const { records, preview } = parsePasswordCsv(
      "https://example.com/,alice,SuperSecret123\nhttps://b.test/,bob,pw"
    );

    expect(records).toEqual([]);
    expect(preview.detectedColumns).toEqual([]);
    expect(preview.validRows).toBe(0);
    expect(preview.rejectedRows).toBe(preview.totalRows);
    expect(codes(preview.warnings)).toContain("csv-headers-unrecognised");
    expect(JSON.stringify(preview)).not.toContain("SuperSecret123");
  });

  it("accepts nothing when the password column is missing", () => {
    const { records, preview } = parsePasswordCsv("url,username\nhttps://a.test/,alice");

    expect(records).toEqual([]);
    expect(preview.validRows).toBe(0);
    expect(codes(preview.warnings)).toContain("csv-missing-password-column");
  });

  it("accepts nothing when the address column is missing", () => {
    const { records, preview } = parsePasswordCsv("username,password\nalice,pw");

    expect(records).toEqual([]);
    expect(codes(preview.warnings)).toContain("csv-missing-url-column");
  });

  it("allows a blank username but never a blank password", () => {
    const { records, preview } = parsePasswordCsv(
      ["url,username,password", "https://a.test/,,pw", "https://b.test/,bob,"].join("\n")
    );

    expect(records).toEqual([{ url: "https://a.test/", username: "", password: "pw" }]);
    expect(preview.rejectedRows).toBe(1);
    expect(codes(preview.warnings)).toContain("csv-malformed-rows-skipped");
  });

  it("rejects credentials for schemes a browser cannot present", () => {
    const { records, preview } = parsePasswordCsv(
      [
        "url,username,password",
        "android://a1b2@com.example.app/,alice,pw",
        "javascript:alert(1),bob,pw",
        "file:///c:/secrets,carol,pw",
        "https://ok.test/,dave,pw"
      ].join("\n")
    );

    expect(records).toEqual([{ url: "https://ok.test/", username: "dave", password: "pw" }]);
    expect(preview.rejectedRows).toBe(3);
  });

  it("handles quoted fields containing delimiters, quotes, and newlines", () => {
    const { records } = parsePasswordCsv(
      ['url,username,password', '"https://a.test/?a=1,b=2","al""ice","pw,with\nnewline"'].join("\n")
    );

    expect(records).toEqual([
      {
        url: "https://a.test/?a=1,b=2",
        username: 'al"ice',
        password: "pw,with\nnewline"
      }
    ]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(parsePasswordCsv("url;username;password\nhttps://a.test/;alice;pw").records).toHaveLength(1);
    expect(parsePasswordCsv("url\tusername\tpassword\nhttps://a.test/\talice\tpw").records).toHaveLength(1);
  });

  it("tolerates CRLF line endings and a byte-order mark", () => {
    const { records } = parsePasswordCsv(
      "\uFEFFurl,username,password\r\nhttps://a.test/,alice,pw\r\n"
    );
    expect(records).toHaveLength(1);
  });

  it("reports an empty file rather than failing", () => {
    for (const text of ["", "   ", "\n\n"]) {
      const { records, preview } = parsePasswordCsv(text);
      expect(records).toEqual([]);
      expect(codes(preview.warnings)).toContain("csv-empty");
    }
  });

  it("reports a header with no rows as empty", () => {
    const { preview } = parsePasswordCsv("url,username,password\n");
    expect(preview.totalRows).toBe(0);
    expect(codes(preview.warnings)).toContain("csv-empty");
  });

  it("stops at the row limit", () => {
    const rows = Array.from(
      { length: MAX_CSV_ROWS + 25 },
      (_unused, index) => `https://example.com/${index},user${index},pw${index}`
    );
    const { records, preview } = parsePasswordCsv(
      ["url,username,password", ...rows].join("\n")
    );

    expect(records.length).toBeLessThanOrEqual(MAX_CSV_ROWS);
    expect(codes(preview.warnings)).toContain("csv-truncated");
  });

  it("bounds a column name taken from the file", () => {
    const { preview } = parsePasswordCsv(
      `url,username,password,${"x".repeat(300)}\nhttps://a.test/,alice,pw,y`
    );

    for (const name of preview.detectedColumns) expect(name.length).toBeLessThanOrEqual(40);
  });

  it("counts short rows as rejected rather than shifting columns", () => {
    const { records, preview } = parsePasswordCsv(
      ["url,username,password", "https://a.test/", "https://b.test/,bob,pw"].join("\n")
    );

    expect(records).toEqual([{ url: "https://b.test/", username: "bob", password: "pw" }]);
    expect(preview.rejectedRows).toBe(1);
  });
});
