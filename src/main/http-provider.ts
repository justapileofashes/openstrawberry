/**
 * The one place a credential goes onto the wire.
 *
 * Everything about the request except authorisation is built in
 * `../shared/provider-request.js`, which never receives a key. This module adds
 * the header immediately before sending and does nothing else with it: it is not
 * logged, not stored, not returned, and not included in any error.
 *
 * Four rules make this safe to point at a user-supplied endpoint:
 *
 *   1. **Redirects are refused, never followed.** This is the rule that matters
 *      most. A provider endpoint that answers 302 to another host would, under a
 *      following client, receive the Authorization header on the second request
 *      - handing the key to whoever controls the redirect target. `redirect:
 *      "error"` means a redirect is a failed request rather than a silent
 *      forward.
 *   2. **The request is bounded in time.** A provider that accepts a connection
 *      and never answers would otherwise hold a run open forever.
 *   3. **The response is bounded in size**, read against the bytes as they
 *      arrive rather than against a header the server chose.
 *   4. **Failures are codes.** A provider's own error text is remote content
 *      and could carry anything, including fragments of the request that was
 *      sent to it. The chrome renders wording it holds itself.
 */
import {
  buildChatRequest,
  dialectFor,
  errorForStatus,
  MAX_RESPONSE_BYTES,
  parseChatReply,
  REQUEST_TIMEOUT_MS,
  type ProviderResult
} from "../shared/provider-request.js";
import type { ProviderId } from "../shared/agents.js";
import { readBoundedStream } from "./favicon.js";

/** The fetch this module uses. Injected so the whole path is testable. */
export type FetchPort = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly redirect: "error";
    readonly signal: AbortSignal;
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}>;

export interface ProviderCallOptions {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string | null;
  /** Null when the provider authenticates itself, such as a local runtime. */
  readonly credential: string | null;
  readonly prompt: string;
  readonly fetch: FetchPort;
  /** Lets a cancelled run abandon a request in flight. */
  readonly signal?: AbortSignal;
}

/**
 * Adds authorisation for one request.
 *
 * Returns a fresh object rather than mutating the shared headers, so the key
 * exists only inside this call's own map and goes out of scope with it.
 */
function withAuthorisation(
  headers: Readonly<Record<string, string>>,
  provider: ProviderId,
  credential: string | null
): Record<string, string> {
  const sent: Record<string, string> = { ...headers };
  if (credential === null || credential.length === 0) return sent;

  // Anthropic takes its key in its own header; everything else this app speaks
  // to uses a bearer token.
  if (provider === "anthropic") sent["x-api-key"] = credential;
  else sent["authorization"] = `Bearer ${credential}`;

  return sent;
}

/**
 * Calls a provider and returns its text, or a code.
 *
 * Never throws and never returns anything derived from the provider's error
 * body, so a caller can put the result straight into a run log.
 */
export async function callProvider(options: ProviderCallOptions): Promise<ProviderResult> {
  const dialect = dialectFor(options.provider);
  if (dialect === null) return { ok: false, code: "unsupported-provider" };

  // A provider that authenticates requests must have something to authenticate
  // with. Ollama and the CLIs are the exceptions and pass null deliberately.
  const needsCredential = options.provider !== "ollama";
  if (needsCredential && (options.credential === null || options.credential.length === 0)) {
    return { ok: false, code: "no-credential" };
  }

  const request = buildChatRequest(
    options.provider,
    options.model,
    options.baseUrl,
    options.prompt
  );
  if (request === null) return { ok: false, code: "bad-endpoint" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // A cancelled run abandons the request rather than waiting for the timeout.
  const onCancel = (): void => controller.abort();
  options.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    let response: Awaited<ReturnType<FetchPort>>;
    try {
      response = await options.fetch(request.url, {
        method: "POST",
        headers: withAuthorisation(request.headers, options.provider, options.credential),
        body: request.body,
        // Never follow. See the note at the top of this file.
        redirect: "error",
        signal: controller.signal
      });
    } catch {
      if (options.signal?.aborted === true) return { ok: false, code: "cancelled" };
      if (controller.signal.aborted) return { ok: false, code: "timeout" };
      /*
       * A refused redirect surfaces as a fetch failure, indistinguishable here
       * from a DNS or TLS failure. Both are reported as `network`: the
       * difference does not change what the user should do, and guessing at it
       * from an error message would be reading remote text to decide.
       */
      return { ok: false, code: "network" };
    }

    if (!response.ok) return { ok: false, code: errorForStatus(response.status) };

    const bytes = await readBoundedStream(response.body, MAX_RESPONSE_BYTES);
    if (bytes === null) return { ok: false, code: "too-large" };
    if (bytes.byteLength === 0) return { ok: false, code: "malformed-reply" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return { ok: false, code: "malformed-reply" };
    }

    return parseChatReply(request.dialect, parsed);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
  }
}
