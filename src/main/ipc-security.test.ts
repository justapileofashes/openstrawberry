import { describe, expect, it } from "vitest";
import { assertTrustedRendererId } from "./ipc-security.js";

describe("trusted IPC renderer gate", () => {
  it("allows only the current main-window renderer", () => {
    expect(() => assertTrustedRendererId(42, 42)).not.toThrow();
  });

  it("rejects calls when no main window exists or the sender differs", () => {
    expect(() => assertTrustedRendererId(42, undefined)).toThrow("untrusted renderer");
    expect(() => assertTrustedRendererId(7, 42)).toThrow("untrusted renderer");
  });
});
