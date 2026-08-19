#!/usr/bin/env node
/**
 * Verifies what a release build actually produced.
 *
 * Three questions, none of which a successful `electron-builder` exit answers:
 *
 *   1. Is every artifact this platform was supposed to produce present, under
 *      the name the rest of the project expects?
 *   2. Is it really signed? On Windows, electron-builder logs
 *      `signing with signtool.exe` even with no certificate configured, so its
 *      output cannot be read as confirmation — `docs/RELEASES.md` warns about
 *      exactly this. The signature is therefore checked against the file.
 *   3. Does the published checksum match the bytes on disk right now?
 *
 * The expected names come from `PLANNED_RELEASE_ARTIFACTS` in the compiled
 * shared module, so this script and the application cannot disagree about what a
 * release is called.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const RELEASE_DIR = process.argv[2] ?? "release";

/** Which planned artifacts this platform is responsible for. */
const EXPECTED_BY_PLATFORM = {
  win32: ["win-x64"],
  darwin: ["mac-universal"],
  linux: ["linux-appimage", "linux-deb", "linux-rpm"]
};

const failures = [];
const notes = [];

/**
 * Set by a deliberate unsigned-prerelease run; see scripts/release-preflight.mjs
 * for why the escape hatch exists and how narrow it is. It downgrades *only*
 * signature verdicts. A missing, empty, misnamed, or checksum-mismatched
 * artifact still fails the run, because none of those is a thing a prerelease
 * is allowed to be either.
 */
const ALLOW_UNSIGNED = (process.env.OPENSTRAWBERRY_ALLOW_UNSIGNED ?? "").trim().length > 0;

function fail(message) {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
}

/** A signature verdict: fatal normally, a loud note in an unsigned prerelease. */
function failSignature(message) {
  if (ALLOW_UNSIGNED) note(`${message} — permitted, this is an UNSIGNED prerelease`);
  else fail(message);
}

function pass(message) {
  console.log(`  ok    ${message}`);
}

function note(message) {
  notes.push(message);
  console.log(`  note  ${message}`);
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Signature checks                                                            */
/* -------------------------------------------------------------------------- */

function verifyWindowsSignature(path) {
  let status;
  try {
    status = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-AuthenticodeSignature -LiteralPath '${path}').Status`
      ],
      { encoding: "utf8" }
    ).trim();
  } catch {
    failSignature(`${path}: could not read the Authenticode signature`);
    return;
  }

  if (status === "Valid") pass(`${path}: Authenticode signature Valid`);
  else failSignature(`${path}: Authenticode status is ${status}, not Valid`);
}

function verifyMacSignature(path) {
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", path], { stdio: "pipe" });
    pass(`${path}: codesign verification passed`);
  } catch {
    failSignature(`${path}: codesign verification failed`);
    return;
  }

  try {
    // Gatekeeper's own judgement, which is what a user's machine applies. A DMG
    // is assessed as an install source rather than as an executable.
    execFileSync("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", path], {
      stdio: "pipe"
    });
    pass(`${path}: Gatekeeper assessment passed (notarised)`);
  } catch {
    failSignature(`${path}: Gatekeeper rejected the artifact — it is signed but not notarised`);
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  const platform = process.platform;
  const keys = EXPECTED_BY_PLATFORM[platform] ?? [];

  if (keys.length === 0) {
    console.error(`No planned artifacts are defined for ${platform}.`);
    process.exit(1);
  }

  let planned;
  try {
    ({ PLANNED_RELEASE_ARTIFACTS: planned } = await import("../dist/shared/desktop-shell.js"));
  } catch {
    console.error("Could not load dist/shared/desktop-shell.js. Run `pnpm build` first.");
    process.exit(1);
  }

  console.log(`\nVerifying ${platform} release artifacts in ${RELEASE_DIR}/\n`);

  const present = [];

  for (const key of keys) {
    const name = planned[key];
    const path = join(RELEASE_DIR, name);

    if (!(await exists(path))) {
      fail(`${name}: expected artifact is missing`);
      continue;
    }

    const { size } = await stat(path);
    if (size === 0) {
      fail(`${name}: artifact is empty`);
      continue;
    }

    pass(`${name}: present (${(size / 1024 / 1024).toFixed(1)} MB)`);
    present.push({ name, path });

    if (platform === "win32") verifyWindowsSignature(path);
    else if (platform === "darwin") verifyMacSignature(path);
    else note(`${name}: Linux artifacts carry no embedded signature; the checksum is the claim`);
  }

  /* Checksums ------------------------------------------------------------- */

  const sumsPath = join(RELEASE_DIR, "SHA256SUMS.txt");
  if (!(await exists(sumsPath))) {
    fail("SHA256SUMS.txt is missing — run `pnpm checksums`");
  } else {
    const published = new Map(
      (await readFile(sumsPath, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [digest, ...rest] = line.trim().split(/\s+/u);
          return [rest.join(" "), digest];
        })
    );

    for (const artifact of present) {
      const claimed = published.get(artifact.name);
      if (claimed === undefined) {
        fail(`${artifact.name}: no published checksum`);
        continue;
      }

      const actual = await sha256(artifact.path);
      if (actual === claimed) pass(`${artifact.name}: checksum matches`);
      else fail(`${artifact.name}: checksum mismatch — the file changed after it was hashed`);
    }
  }

  /* ------------------------------------------------------------------------ */

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed. These artifacts must not be distributed.\n`);
    process.exit(1);
  }

  console.log(
    `All checks passed for ${platform}.` +
      (notes.length > 0 ? ` ${notes.length} note(s) above.` : "") +
      "\n"
  );

  if (ALLOW_UNSIGNED) {
    console.log(
      "These artifacts are UNSIGNED. They are present, correctly named, and match\n" +
        "their checksums, and that is the whole of what has been verified. Publish\n" +
        "them as a prerelease that says so, or not at all.\n"
    );
  }
}

await main();
