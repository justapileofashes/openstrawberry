export function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "https://example.com";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/\s/.test(trimmed) || !trimmed.includes(".")) return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  return `https://${trimmed}`;
}

export function isBrowserUrlAllowed(input: string): boolean {
  try {
    const protocol = new URL(input).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
