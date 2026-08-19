/**
 * The password CSV reader.
 *
 * This is the only code in OpenStrawberry that ever holds a browser password in
 * memory, so its shape matters as much as its behaviour:
 *
 *   - `parsePasswordCsv` returns two things that must not be confused. The
 *     `preview` is the renderer's half: counts, recognised column names, and
 *     warning codes. The `records` are the trusted process's half and never
 *     leave it except as ciphertext.
 *   - Column names are reported only when the first row is *recognisably* a
 *     header. A file exported without one would otherwise put a live credential
 *     into a field the review screen renders.
 *   - No value — not a password, not a username, not an address — is ever
 *     interpolated into a warning. Warnings are codes with counts.
 *
 * JavaScript strings are immutable, so a parsed password cannot be wiped in
 * place. The mitigation is lifetime, not erasure: the records live in one
 * main-process map, are encrypted or dropped on the user's next action, and are
 * dropped unconditionally when the wizard closes.
 */

import {
  MAX_COLUMN_NAME_LENGTH,
  MAX_CSV_COLUMNS,
  MAX_CSV_FIELD_LENGTH,
  MAX_CSV_ROWS,
  WarningLedger,
  isImportableBookmarkUrl,
  type PasswordCsvPreview
} from "../shared/migration.js";

/**
 * One credential, as the staging step will encrypt it.
 *
 * Main-process only. Nothing on the IPC bridge has this type, and nothing that
 * does may gain one.
 */
export interface StagedPasswordRecord {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export interface PasswordCsvParseResult {
  /** Never crosses IPC. See the module note. */
  readonly records: readonly StagedPasswordRecord[];
  /** Safe to show. Counts, recognised column names, and warning codes only. */
  readonly preview: PasswordCsvPreview;
}

/* ------------------------------------------------------------------------- */
/* Column recognition                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Header aliases, normalised to letters and digits.
 *
 * Every mainstream exporter is covered — Chromium's `name,url,username,password`,
 * Firefox's `url,username,password`, Bitwarden's `login_uri,login_username,
 * login_password`, 1Password's `website`, KeePass's `Login Name` — because the
 * cost of not recognising a column is a user told their file is unreadable when
 * it is merely spelled differently.
 */
const URL_ALIASES: readonly string[] = [
  "url",
  "urls",
  "origin",
  "originurl",
  "website",
  "websiteurl",
  "webaddress",
  "site",
  "siteurl",
  "loginuri",
  "hostname",
  "host"
];

const USERNAME_ALIASES: readonly string[] = [
  "username",
  "user",
  "userid",
  "login",
  "loginname",
  "loginusername",
  "email",
  "emailaddress",
  "account",
  "accountname"
];

const PASSWORD_ALIASES: readonly string[] = [
  "password",
  "pass",
  "passwd",
  "loginpassword"
];

/** Reduces a header cell to the form the alias tables are written in. */
function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** Bounds and cleans a header name before it is shown on the review screen. */
function displayHeader(value: string): string {
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ").replace(/\s+/gu, " ").trim();
  return cleaned.length > MAX_COLUMN_NAME_LENGTH
    ? cleaned.slice(0, MAX_COLUMN_NAME_LENGTH)
    : cleaned;
}

interface ColumnMap {
  readonly url: number;
  readonly username: number;
  readonly password: number;
}

/**
 * Maps a header row onto the three columns that matter.
 *
 * The first match wins, so a file carrying both `url` and `login_uri` uses
 * whichever the exporter put first rather than depending on table order here.
 */
function mapColumns(header: readonly string[]): ColumnMap {
  let url = -1;
  let username = -1;
  let password = -1;

  for (let index = 0; index < header.length; index += 1) {
    const key = normalizeHeader(header[index] ?? "");
    if (key.length === 0) continue;

    if (url === -1 && URL_ALIASES.includes(key)) url = index;
    else if (username === -1 && USERNAME_ALIASES.includes(key)) username = index;
    else if (password === -1 && PASSWORD_ALIASES.includes(key)) password = index;
  }

  return { url, username, password };
}

/* ------------------------------------------------------------------------- */
/* Delimiter and tokenisation                                                 */
/* ------------------------------------------------------------------------- */

const DELIMITERS: readonly string[] = [",", ";", "\t"];

/**
 * Picks the delimiter from the first line.
 *
 * A locale-configured spreadsheet exports semicolons, and some tools export
 * tabs. Guessing from the header line is reliable because a header row is short
 * and contains no free text, and a wrong guess degrades to "no columns
 * recognised" rather than to a misread credential.
 */
function detectDelimiter(text: string): string {
  const newline = text.search(/\r?\n/u);
  const firstLine = newline === -1 ? text.slice(0, 4096) : text.slice(0, newline);

  let best = ",";
  let bestCount = 0;

  for (const candidate of DELIMITERS) {
    let count = 0;
    for (const character of firstLine) if (character === candidate) count += 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }

  return best;
}

interface TokenizedCsv {
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
  /** Rows whose field count did not match the header, or that broke a bound. */
  readonly malformed: number;
}

/**
 * Splits CSV text into rows of fields.
 *
 * Handles the parts of RFC 4180 that exporters actually emit: quoted fields,
 * doubled quotes inside them, embedded delimiters and newlines, and either line
 * ending. Every bound is enforced during the scan rather than after it, so a
 * hostile file cannot force a large allocation before being rejected.
 */
function tokenize(text: string, delimiter: string): TokenizedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let overlong = false;
  let malformed = 0;
  let truncated = false;

  const pushField = (): void => {
    if (row.length >= MAX_CSV_COLUMNS) {
      overlong = true;
      return;
    }
    row.push(field);
    field = "";
  };

  const pushRow = (): boolean => {
    pushField();

    // A trailing newline produces one empty field; that is not a row.
    const isBlank = row.length === 1 && (row[0] ?? "").length === 0;
    if (!isBlank) {
      if (overlong) malformed += 1;
      rows.push(row);
    }

    row = [];
    overlong = false;

    // The header occupies one row, so the cap is data rows plus it.
    if (rows.length > MAX_CSV_ROWS) {
      truncated = true;
      return false;
    }
    return true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
        continue;
      }
      if (field.length < MAX_CSV_FIELD_LENGTH) field += character;
      else overlong = true;
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
      continue;
    }

    if (character === delimiter) {
      pushField();
      continue;
    }

    if (character === "\n") {
      if (!pushRow()) return { rows, truncated, malformed };
      continue;
    }

    if (character === "\r") continue;

    if (field.length < MAX_CSV_FIELD_LENGTH) field += character;
    else overlong = true;
  }

  if (field.length > 0 || row.length > 0) pushRow();

  return { rows, truncated, malformed };
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* ------------------------------------------------------------------------- */

function emptyPreview(warnings: WarningLedger, totalRows = 0): PasswordCsvPreview {
  return {
    totalRows,
    validRows: 0,
    rejectedRows: totalRows,
    detectedColumns: [],
    warnings: warnings.list()
  };
}

/**
 * Reads a password export.
 *
 * A row is accepted only when it carries a password and an http(s) address. An
 * `android://` or other non-web origin is counted as rejected rather than
 * staged: it is a credential this browser could never present, and storing one
 * would be keeping a secret for no purpose.
 */
export function parsePasswordCsv(text: string): PasswordCsvParseResult {
  const warnings = new WarningLedger();
  const body = text.replace(/^\uFEFF/u, "");

  if (body.trim().length === 0) {
    warnings.add("csv-empty");
    return { records: [], preview: emptyPreview(warnings) };
  }

  const { rows, truncated, malformed } = tokenize(body, detectDelimiter(body));
  if (truncated) warnings.add("csv-truncated");

  const header = rows[0];
  if (header === undefined) {
    warnings.add("csv-empty");
    return { records: [], preview: emptyPreview(warnings) };
  }

  const dataRows = rows.slice(1);
  const totalRows = dataRows.length;

  const columns = mapColumns(header);

  /*
   * Nothing recognised means the first row is not a header — which very likely
   * means it is a credential. No column names are reported and no row is
   * accepted, because both would involve treating a secret as a label.
   */
  if (columns.url === -1 && columns.username === -1 && columns.password === -1) {
    warnings.add("csv-headers-unrecognised");
    return { records: [], preview: emptyPreview(warnings, totalRows) };
  }

  // The first row is now known to be a header, so its cells are safe to show.
  const detectedColumns = header
    .slice(0, MAX_CSV_COLUMNS)
    .map(displayHeader)
    .filter((name) => name.length > 0);

  if (columns.password === -1) warnings.add("csv-missing-password-column");
  if (columns.url === -1) warnings.add("csv-missing-url-column");
  if (columns.username === -1) warnings.add("csv-missing-username-column");

  if (columns.password === -1 || columns.url === -1) {
    // Without both, no row can produce a usable credential.
    return {
      records: [],
      preview: {
        totalRows,
        validRows: 0,
        rejectedRows: totalRows,
        detectedColumns,
        warnings: warnings.list()
      }
    };
  }

  if (totalRows === 0) {
    warnings.add("csv-empty");
    return {
      records: [],
      preview: { totalRows: 0, validRows: 0, rejectedRows: 0, detectedColumns, warnings: warnings.list() }
    };
  }

  const records: StagedPasswordRecord[] = [];
  let malformedRows = malformed;

  for (const row of dataRows) {
    const url = (row[columns.url] ?? "").trim();
    const password = row[columns.password] ?? "";
    const username = columns.username === -1 ? "" : (row[columns.username] ?? "").trim();

    if (password.length === 0 || url.length === 0) {
      malformedRows += 1;
      continue;
    }

    // The same http(s) gate bookmarks pass through. A credential for a scheme
    // this browser cannot navigate to is not one it should hold.
    if (!isImportableBookmarkUrl(url)) {
      malformedRows += 1;
      continue;
    }

    records.push({ url, username, password });
  }

  if (malformedRows > 0) warnings.add("csv-malformed-rows-skipped", malformedRows);

  return {
    records,
    preview: {
      totalRows,
      validRows: records.length,
      rejectedRows: totalRows - records.length,
      detectedColumns,
      warnings: warnings.list()
    }
  };
}
