const MAX_ADDRESS_LENGTH = 8_192;

export function normalizeAddress(input: unknown): string {
  if (typeof input !== "string") throw new Error("The browser address must be text.");
  if (input.length > MAX_ADDRESS_LENGTH) throw new Error("The browser address is too long.");
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/\s/.test(trimmed) || !trimmed.includes(".")) return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  return `https://${trimmed}`;
}

export function isBrowserUrlAllowed(input: string): boolean {
  try {
    const protocol = new URL(input).protocol;
    return protocol === "http:" || protocol === "https:" || input === "about:blank";
  } catch {
    return false;
  }
}

export function normalizeBrowserUrl(input: unknown): string {
  const normalized = normalizeAddress(input);
  if (!isBrowserUrlAllowed(normalized)) throw new Error("Only HTTP and HTTPS browser addresses are allowed.");
  return normalized;
}
