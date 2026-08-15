const TRACKER_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "connect.facebook.net",
  "hotjar.com",
  "clarity.ms",
  "bat.bing.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com"
] as const;

const NAVIGATION_RESOURCE_TYPES = new Set(["mainFrame", "subFrame"]);

export type PrivacyState = { trackerBlockingEnabled: boolean; activeSiteException: boolean; activeTabBlockedRequests: number };

export function normalizePrivacyHost(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("A valid http(s) site URL is required.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("A valid http(s) site URL is required."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A valid http(s) site URL is required.");
  if (!url.hostname || url.hostname.length > 253) throw new Error("A valid site host is required.");
  return url.hostname.toLowerCase();
}

export function isKnownTrackerHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return TRACKER_HOSTS.some((tracker) => normalized === tracker || normalized.endsWith(`.${tracker}`));
}

export function shouldBlockTrackerRequest(input: { url: string; referrer: string; resourceType: string; enabled: boolean; allowedHosts: readonly string[] }): boolean {
  if (!input.enabled || NAVIGATION_RESOURCE_TYPES.has(input.resourceType)) return false;
  let targetHost: string;
  try { targetHost = new URL(input.url).hostname; } catch { return false; }
  if (!isKnownTrackerHost(targetHost)) return false;
  try { return !input.allowedHosts.includes(normalizePrivacyHost(input.referrer)); } catch { return true; }
}
