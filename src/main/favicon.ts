/**
 * Resolves site favicons into inline data URLs.
 *
 * The chrome renderer ships a strict `img-src 'self' data:` policy, so it
 * cannot load a remote favicon directly — and loosening that to `https:` would
 * turn the trusted chrome into a client that fetches from every site the user
 * visits, which is a tracking surface the page itself does not otherwise get.
 *
 * Instead the main process fetches the icon inside the guest's own session, so
 * the request rides the connection context the page already established, and
 * hands the renderer a bounded data URL.
 */
import type { Session } from "electron";

/** Favicons are small. Anything larger is not worth trusting or decoding. */
export const MAX_FAVICON_BYTES = 128 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml"
]);

/** Bounds memory across a long browsing session. */
const MAX_CACHE_ENTRIES = 256;

export function isAllowedFaviconMime(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_MIME.has(mime);
}

/**
 * The conventional fallback location, used when a page declares no icon.
 * HTTPS only, matching the favicon policy in the navigation module.
 */
export function conventionalFaviconUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "https:") return null;
    return `${url.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function toDataUrl(contentType: string, bytes: Uint8Array): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "image/png";
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * Reads a response body, abandoning it the moment it exceeds `maxBytes`.
 *
 * `arrayBuffer()` cannot do this job: it allocates the entire body and only then
 * hands back something whose size can be checked, which is no bound at all
 * against a server that never stops sending. `content-length` cannot do it
 * either — it is absent from every chunked response, so the header check has
 * nothing to test.
 *
 * That matters here specifically because this read is reachable from ordinary
 * browsing: any page can declare any icon URL, and this runs in the main
 * process, where exhausting memory takes down the whole browser rather than one
 * tab. So the cap is enforced against the bytes as they arrive.
 *
 * Returns null past the cap, making an oversized icon the same cosmetic
 * non-event as a missing one.
 */
export async function readBoundedStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<Uint8Array | null> {
  if (body === null) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      // Checked before the chunk is retained, so the peak held is one chunk over
      // the cap rather than the whole of whatever the server chose to send.
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    // Closes the connection whether the body ended or the cap ended it.
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class FaviconResolver {
  private readonly cache = new Map<string, string | null>();

  public constructor(private readonly profile: Session) {}

  /**
   * Returns a data URL, or null when the icon is missing, oversized, or not an
   * image. A failure here is cosmetic, so it never propagates.
   */
  public async resolve(url: string): Promise<string | null> {
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;

    const resolved = await this.fetchIcon(url);

    // Cheap FIFO eviction; favicon churn does not warrant an LRU.
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(url, resolved);

    return resolved;
  }

  private async fetchIcon(url: string): Promise<string | null> {
    try {
      // Fetching through the guest's own session keeps the request inside the
      // connection context the page already established, rather than making the
      // trusted chrome a separate client of every site the user visits.
      const response = await this.profile.fetch(url, {
        // A decorative request must never carry the user's credentials.
        credentials: "omit",
        redirect: "follow"
      });

      if (!response.ok) return null;

      const contentType = response.headers.get("content-type");
      if (!isAllowedFaviconMime(contentType)) return null;

      // An honest oversized icon is refused without being fetched at all. A
      // dishonest or chunked one is refused by the bounded read below.
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > MAX_FAVICON_BYTES) return null;

      const buffer = await readBoundedStream(response.body, MAX_FAVICON_BYTES);
      if (buffer === null || buffer.byteLength === 0) return null;

      return toDataUrl(contentType ?? "image/png", buffer);
    } catch {
      return null;
    }
  }
}
