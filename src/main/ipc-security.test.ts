import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../shared/bridge.js";
import { IpcValidationError } from "../shared/ipc-validation.js";
import {
  assertTrustedSender,
  buildAllowedUrlPrefixes,
  IpcSecurityError,
  isTrustedSender,
  redactErrorForRenderer,
  type IncomingIpcEvent,
  type TrustedRendererPolicy
} from "./ipc-security.js";

const POLICY: TrustedRendererPolicy = {
  trustedWebContentsId: 1,
  allowedUrlPrefixes: ["file://", "http://127.0.0.1:5173"]
};

function event(overrides: Partial<IncomingIpcEvent> = {}): IncomingIpcEvent {
  return {
    senderWebContentsId: 1,
    senderFrameUrl: "file:///C:/app/dist/renderer/index.html",
    senderIsMainFrame: true,
    ...overrides
  };
}

describe("isTrustedSender", () => {
  it("accepts the packaged chrome renderer", () => {
    expect(isTrustedSender(event(), POLICY)).toBe(true);
  });

  it("accepts the loopback dev server renderer", () => {
    expect(isTrustedSender(event({ senderFrameUrl: "http://127.0.0.1:5173/" }), POLICY)).toBe(true);
  });

  it("rejects a different WebContents, which is what every guest view is", () => {
    expect(isTrustedSender(event({ senderWebContentsId: 2 }), POLICY)).toBe(false);
  });

  it("rejects subframes even inside the trusted WebContents", () => {
    expect(isTrustedSender(event({ senderIsMainFrame: false }), POLICY)).toBe(false);
  });

  it("rejects a destroyed or missing sender frame", () => {
    expect(isTrustedSender(event({ senderFrameUrl: null }), POLICY)).toBe(false);
    expect(isTrustedSender(event({ senderFrameUrl: "" }), POLICY)).toBe(false);
  });

  it("rejects remote origins", () => {
    for (const url of [
      "https://example.com/",
      "http://evil.test/",
      "data:text/html,<script>1</script>",
      "javascript:alert(1)",
      "about:blank"
    ]) {
      expect(isTrustedSender(event({ senderFrameUrl: url }), POLICY)).toBe(false);
    }
  });

  it("rejects an origin that merely embeds an allowed prefix later in the URL", () => {
    expect(
      isTrustedSender(event({ senderFrameUrl: "https://evil.test/?next=file://" }), POLICY)
    ).toBe(false);
  });
});

describe("assertTrustedSender", () => {
  it("passes for the trusted renderer", () => {
    expect(() => assertTrustedSender(event(), POLICY, "browser:navigate")).not.toThrow();
  });

  it("throws IpcSecurityError naming the channel", () => {
    expect(() => assertTrustedSender(event({ senderWebContentsId: 9 }), POLICY, "browser:navigate"))
      .toThrow(IpcSecurityError);
    expect(() => assertTrustedSender(event({ senderWebContentsId: 9 }), POLICY, "browser:navigate"))
      .toThrow(/browser:navigate/u);
  });

  it("does not leak the attacker-controlled URL into the error", () => {
    const hostile = "https://evil.test/steal?token=abc123";
    expect(() => assertTrustedSender(event({ senderFrameUrl: hostile }), POLICY, "browser:navigate"))
      .toThrow(expect.objectContaining({ message: expect.not.stringContaining("evil.test") }));
  });

  /*
   * Migration reads another application's data and can encrypt credentials, so
   * it is the subsystem where an unverified sender would cost the most. The
   * router applies this same check to every channel with no per-channel opt-out;
   * these cases pin that the migration channels are covered by it.
   */
  it("rejects every migration channel from a sender that is not the chrome", () => {
    const channels = Object.values(IPC_CHANNELS).filter((channel) =>
      channel.startsWith("migration:")
    );

    expect(channels.length).toBeGreaterThan(0);

    for (const channel of channels) {
      // A guest view: same application, different WebContents.
      expect(() => assertTrustedSender(event({ senderWebContentsId: 2 }), POLICY, channel)).toThrow(
        IpcSecurityError
      );
      // A subframe inside the chrome, which an embedded document could be.
      expect(() => assertTrustedSender(event({ senderIsMainFrame: false }), POLICY, channel)).toThrow(
        IpcSecurityError
      );
      // A remote origin that somehow reached the bridge.
      expect(() =>
        assertTrustedSender(event({ senderFrameUrl: "https://evil.test/" }), POLICY, channel)
      ).toThrow(IpcSecurityError);

      expect(() => assertTrustedSender(event(), POLICY, channel)).not.toThrow();
    }
  });
});

describe("redactErrorForRenderer", () => {
  it("passes through security errors, which name only a channel", () => {
    expect(redactErrorForRenderer(new IpcSecurityError("Rejected untrusted IPC sender."))).toBe(
      "Rejected untrusted IPC sender."
    );
  });

  it("passes through validation errors, which name only a field", () => {
    expect(redactErrorForRenderer(new IpcValidationError("Tab ID must be a string."))).toBe(
      "Tab ID must be a string."
    );
  });

  it("collapses arbitrary errors so local paths never reach the renderer", () => {
    const leaky = new Error("ENOENT: open 'C:\\Users\\ashton\\AppData\\agent-vault.json'");
    const redacted = redactErrorForRenderer(leaky);
    expect(redacted).toBe("The request could not be completed.");
    expect(redacted).not.toContain("ashton");
    expect(redacted).not.toContain("agent-vault");
  });

  it("collapses credential-bearing failures", () => {
    const leaky = new Error("401 from provider with key sk-live-abc123");
    expect(redactErrorForRenderer(leaky)).not.toContain("sk-live-abc123");
  });

  it("handles non-Error throws", () => {
    expect(redactErrorForRenderer("C:\\secret\\path")).toBe("The request could not be completed.");
    expect(redactErrorForRenderer(undefined)).toBe("The request could not be completed.");
  });
});

describe("buildAllowedUrlPrefixes", () => {
  it("always allows the packaged file bundle", () => {
    expect(buildAllowedUrlPrefixes(undefined)).toEqual(["file://"]);
  });

  it("adds a loopback dev server origin", () => {
    expect(buildAllowedUrlPrefixes("http://127.0.0.1:5173")).toEqual([
      "file://",
      "http://127.0.0.1:5173"
    ]);
  });

  it("normalises to the origin, discarding any path", () => {
    expect(buildAllowedUrlPrefixes("http://localhost:5173/index.html")).toEqual([
      "file://",
      "http://localhost:5173"
    ]);
  });

  it("refuses a non-loopback dev server, however it is dressed up", () => {
    for (const url of [
      "http://example.com",
      "https://127.0.0.1:5173",
      "http://127.0.0.1.evil.test",
      "not a url"
    ]) {
      expect(buildAllowedUrlPrefixes(url)).toEqual(["file://"]);
    }
  });
});
