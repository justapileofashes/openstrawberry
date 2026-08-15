import { describe, expect, it } from "vitest";
import { DESKTOP_APP_ID, DESKTOP_APP_NAME } from "./desktop-shell.js";

describe("desktop shell identity", () => {
  it("uses the stable native application identity", () => {
    expect(DESKTOP_APP_NAME).toBe("OpenStrawberry");
    expect(DESKTOP_APP_ID).toBe("io.openstrawberry.browser");
  });
});
