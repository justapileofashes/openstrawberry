import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchTargetFromCommandLine } from "./launch-target.js";

let directory = "";
let document = "";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-launch-"));
  document = join(directory, "notes.html");
  writeFileSync(document, "<!doctype html><title>notes</title>", "utf8");
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("launchTargetFromCommandLine", () => {
  it("opens a document that is really there", () => {
    expect(launchTargetFromCommandLine(["exe", document])).toBe(pathToFileURL(document).href);
  });

  it("refuses a document that is not, rather than opening an error page", () => {
    // A moved file or a stale association. Showing Chromium's error page would
    // make the browser look broken for something it did not break.
    expect(launchTargetFromCommandLine(["exe", join(directory, "gone.html")])).toBeNull();
  });

  it("refuses a directory that happens to be named like a document", () => {
    const folder = join(directory, "site.html");
    mkdirSync(folder, { recursive: true });
    expect(launchTargetFromCommandLine(["exe", folder])).toBeNull();
  });

  it("prefers a link over a file when a launch somehow carries both", () => {
    expect(launchTargetFromCommandLine(["exe", document, "https://example.com/"])).toBe(
      "https://example.com/"
    );
  });

  it("returns nothing for an ordinary launch", () => {
    expect(launchTargetFromCommandLine(["exe"])).toBeNull();
    expect(launchTargetFromCommandLine(["exe", "--some-switch"])).toBeNull();
  });

  it("will not open a real file whose type was never registered", () => {
    // The existence check must not become the only check: a file that exists is
    // not thereby a document this app claimed it could render.
    const secret = join(directory, "id_ed25519");
    writeFileSync(secret, "PRIVATE KEY", "utf8");
    expect(launchTargetFromCommandLine(["exe", secret])).toBeNull();
  });
});
