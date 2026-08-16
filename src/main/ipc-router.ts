/**
 * The Electron adapter for OpenStrawberry's IPC trust boundary.
 *
 * Every renderer-reachable channel is registered through this router, which
 * applies the same three steps in the same order, with no per-channel opt-out:
 *
 *   1. Verify the sender really is the trusted chrome renderer.
 *   2. Validate the payload at runtime.
 *   3. Redact any failure before it crosses back to the renderer.
 *
 * The policy checks themselves live in `ipc-security.ts` as pure functions so
 * they stay unit testable without booting Electron.
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  assertTrustedSender,
  redactErrorForRenderer,
  type IncomingIpcEvent,
  type TrustedRendererPolicy
} from "./ipc-security.js";

let policy: TrustedRendererPolicy | null = null;

/** Set once the chrome window exists and its WebContents id is known. */
export function setTrustedRendererPolicy(next: TrustedRendererPolicy): void {
  policy = next;
}

export function clearTrustedRendererPolicy(): void {
  policy = null;
}

function projectEvent(event: IpcMainInvokeEvent): IncomingIpcEvent {
  const frame = event.senderFrame;
  return {
    senderWebContentsId: event.sender.id,
    senderFrameUrl: frame?.url ?? null,
    // Electron marks the top-level frame by it being its own parent-less root.
    senderIsMainFrame: frame !== null && frame !== undefined && frame.parent === null
  };
}

/**
 * Registers a channel that only the trusted renderer may invoke.
 *
 * `parse` must fully validate the raw payload and return the typed value; the
 * handler never sees unvalidated input.
 */
export function registerTrustedHandler<TPayload, TResult>(
  channel: string,
  parse: (raw: unknown) => TPayload,
  handler: (payload: TPayload) => TResult | Promise<TResult>
): void {
  ipcMain.handle(channel, async (event, raw: unknown): Promise<TResult> => {
    try {
      if (policy === null) {
        throw new Error("IPC received before the trusted renderer policy was installed.");
      }

      assertTrustedSender(projectEvent(event), policy, channel);
      return await handler(parse(raw));
    } catch (error) {
      // Full detail stays in the trusted process; the renderer gets a safe
      // message with no local paths, credentials, or stack frames.
      console.error(`[ipc] ${channel} failed:`, error);
      throw new Error(redactErrorForRenderer(error));
    }
  });
}

/** Registers a channel that takes no payload. */
export function registerTrustedQuery<TResult>(
  channel: string,
  handler: () => TResult | Promise<TResult>
): void {
  registerTrustedHandler(channel, () => undefined, handler);
}
