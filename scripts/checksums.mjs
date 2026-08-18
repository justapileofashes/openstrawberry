#!/usr/bin/env node
/**
 * SHA-256 checksums and build provenance for release artifacts.
 *
 * Two files are written beside the artifacts:
 *
 *   - `SHA256SUMS.txt`, in the exact format `sha256sum -c` expects, so a user
 *     verifying a download uses a tool they already have rather than one this
 *     project asks them to trust.
 *   - `provenance.json`, recording which commit produced these bytes on which
 *     runner. A checksum proves a file was not altered in transit; it says
 *     nothing about where it came from, and those are different questions.
 *
 * Hashes are computed by streaming. An installer is ~100MB and this runs on CI
 * runners with real memory limits, so reading one whole into a buffer to hash it
 * would be a needless peak.
 *
 * Node builtins only: this runs in release, where every added dependency is
 * another thing that has to be trusted to produce a trustworthy artifact.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * What counts as a distributable.
 *
 * An allowlist, so the manifest never quietly grows to cover build leftovers.
 * `.blockmap` and `latest*.yml` are update-feed metadata rather than things a
 * person downloads, and are deliberately absent.
 */
const DISTRIBUTABLE = [
  ".exe",
  ".dmg",
  ".pkg",
  ".zip",
  ".appimage",
  ".deb",
  ".rpm",
  ".snap",
  ".tar.gz"
];

const RELEASE_DIR = process.argv[2] ?? "release";

function isDistributable(name) {
  const lower = name.toLowerCase();
  // Never checksum the uninstaller electron-builder leaves in the output
  // directory; it is an intermediate, not something anyone downloads.
  if (lower.includes("__uninstaller")) return false;
  return DISTRIBUTABLE.some((extension) => lower.endsWith(extension));
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

/** Git facts, or null where this is not a checkout (a tarball build, say). */
function gitFact(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main() {
  let entries;
  try {
    entries = await readdir(RELEASE_DIR);
  } catch {
    console.error(`No ${RELEASE_DIR}/ directory. Build the artifacts first.`);
    process.exit(1);
  }

  const names = entries.filter(isDistributable).sort();

  if (names.length === 0) {
    // Not a warning to step past: a release run that produced nothing to publish
    // has failed, and saying so here is cheaper than discovering it at upload.
    console.error(`No release artifacts found in ${RELEASE_DIR}/.`);
    process.exit(1);
  }

  const artifacts = [];
  for (const name of names) {
    const path = join(RELEASE_DIR, name);
    const [digest, stats] = await Promise.all([sha256(path), stat(path)]);
    artifacts.push({ name, size: stats.size, sha256: digest });
    console.log(`${digest}  ${name}`);
  }

  const sums = artifacts.map((entry) => `${entry.sha256}  ${entry.name}\n`).join("");
  await writeFile(join(RELEASE_DIR, "SHA256SUMS.txt"), sums, "utf8");

  const packageJson = JSON.parse(
    await readFileText(new URL("../package.json", import.meta.url))
  );

  const provenance = {
    product: packageJson.productName,
    version: packageJson.version,
    commit: gitFact("rev-parse", "HEAD"),
    ref: process.env["GITHUB_REF"] ?? gitFact("rev-parse", "--abbrev-ref", "HEAD"),
    workflowRun: process.env["GITHUB_RUN_ID"] ?? null,
    builtAt: new Date().toISOString(),
    builtOn: { platform: process.platform, arch: process.arch },
    artifacts
  };

  await writeFile(
    join(RELEASE_DIR, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8"
  );

  console.log(`\nWrote SHA256SUMS.txt and provenance.json for ${artifacts.length} artifact(s).`);
}

async function readFileText(url) {
  const { readFile } = await import("node:fs/promises");
  return readFile(url, "utf8");
}

await main();
