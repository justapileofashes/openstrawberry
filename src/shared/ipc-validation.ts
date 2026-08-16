/**
 * Runtime validation for every renderer-reachable IPC payload.
 *
 * The renderer is untrusted. TypeScript types are erased at runtime and prove
 * nothing about what actually arrives over IPC, so each payload is re-checked
 * here before the main process acts on it.
 *
 * Rules these validators enforce:
 *   - No type coercion. A number is a number, not a numeric string.
 *   - Every string and collection is length-bounded, so a hostile renderer
 *     cannot force unbounded allocation in the trusted process.
 *   - Objects must be plain, and inherited or prototype-polluting keys are
 *     rejected rather than silently accepted.
 */

export class IpcValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IpcValidationError";
  }
}

/** Generous enough for real page titles, short enough to bound allocation. */
export const MAX_TEXT_LENGTH = 2048;
/** Bounds an address bar entry. Real URLs are far shorter than this. */
export const MAX_URL_LENGTH = 4096;
/** Identifiers are app-generated handles, never free text. */
export const MAX_IDENTIFIER_LENGTH = 128;
/** Caps list payloads such as restored tab sets. */
export const MAX_COLLECTION_LENGTH = 256;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(field: string, expectation: string): never {
  // The message names the field and the expectation only. Rejected values are
  // never echoed back, so a hostile payload cannot smuggle content into logs.
  throw new IpcValidationError(`${field} ${expectation}.`);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field, "must be a boolean");
  return value;
}

export function requireString(
  value: unknown,
  field: string,
  maxLength: number = MAX_TEXT_LENGTH
): string {
  if (typeof value !== "string") fail(field, "must be a string");
  if (value.length === 0) fail(field, "must not be empty");
  if (value.length > maxLength) fail(field, `must be at most ${maxLength} characters`);
  return value;
}

/**
 * Identifiers are handles the app itself minted (tab ids, pane ids, agent ids).
 * Restricting the charset keeps them safe to use as object keys, file-name
 * fragments, and log tokens.
 */
export function requireIdentifier(value: unknown, field: string): string {
  const text = requireString(value, field, MAX_IDENTIFIER_LENGTH);
  if (!IDENTIFIER_PATTERN.test(text)) fail(field, "must contain only letters, digits, and . _ : -");
  return text;
}

export function requireInteger(
  value: unknown,
  field: string,
  min: number,
  max: number
): number {
  if (typeof value !== "number") fail(field, "must be a number");
  if (!Number.isInteger(value)) fail(field, "must be an integer");
  if (value < min || value > max) fail(field, `must be between ${min} and ${max}`);
  return value;
}

export function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  if (typeof value !== "string") fail(field, "must be a string");
  if (!allowed.includes(value)) fail(field, `must be one of: ${allowed.join(", ")}`);
  return value;
}

/**
 * Accepts only plain objects. Arrays, class instances, and objects carrying
 * prototype-polluting keys are rejected.
 */
export function requirePlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) fail(field, "must be an object");
  if (Array.isArray(value)) fail(field, "must be an object, not an array");

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) fail(field, "must be a plain object");

  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(field, `must not define ${key}`);
  }

  return value as Record<string, unknown>;
}

export function requireArray(
  value: unknown,
  field: string,
  maxLength: number = MAX_COLLECTION_LENGTH
): readonly unknown[] {
  if (!Array.isArray(value)) fail(field, "must be an array");
  if (value.length > maxLength) fail(field, `must contain at most ${maxLength} items`);
  return value;
}

export function optional<T>(
  value: unknown,
  field: string,
  validate: (value: unknown, field: string) => T
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return validate(value, field);
}
