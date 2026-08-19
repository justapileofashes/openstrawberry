#!/usr/bin/env node
/**
 * Refuses to start a release build that could only produce an undistributable
 * artifact.
 *
 * `docs/RELEASES.md` already says an unsigned build must never be distributed.
 * That was a rule kept by whoever read it. This is the same rule kept by the
 * tooling: `pnpm release` stops here unless this platform can actually sign,
 * naming the specific credential that is missing.
 *
 * The failure is deliberately at the *start* of a release run rather than at
 * upload. Discovering after a three-platform matrix build that nothing can be
 * signed wastes the build; more importantly, a pile of finished-looking
 * artifacts in `release/` is exactly the situation in which someone ships one.
 *
 * `pnpm package` is untouched and still produces unsigned local builds. Testing
 * a build you cannot distribute is a normal thing to want; distributing it is
 * not, and only the second path is gated.
 */

/** Groups of environment variables, any one group being sufficient. */
const WINDOWS_CREDENTIALS = [
  {
    label: "a PKCS#12 certificate",
    all: ["CSC_LINK", "CSC_KEY_PASSWORD"],
    note: "CSC_LINK is a path or base64 of the .pfx; CSC_KEY_PASSWORD is its password."
  },
  {
    label: "Azure Trusted Signing",
    all: [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_CODE_SIGNING_NAME",
      "AZURE_CERT_PROFILE_NAME"
    ],
    note: "Used when signing through Azure rather than a certificate file."
  }
];

const MACOS_SIGNING = [
  {
    label: "a Developer ID certificate",
    all: ["CSC_LINK", "CSC_KEY_PASSWORD"],
    note: "CSC_LINK is a path or base64 of the .p12 holding the Developer ID Application certificate."
  }
];

const MACOS_NOTARIZATION = [
  {
    label: "an App Store Connect API key",
    all: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    note: "The preferred route; the key file is referenced by path."
  },
  {
    label: "an Apple ID app-specific password",
    all: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    note: "The older route. The password must be app-specific, never the account password."
  }
];

function isSet(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/** The first satisfied group, or null when none is. */
function satisfied(groups) {
  return groups.find((group) => group.all.every(isSet)) ?? null;
}

function describe(groups) {
  return groups
    .map((group) => `      - ${group.label}: ${group.all.join(", ")}\n        ${group.note}`)
    .join("\n");
}

function requirementsFor(platform) {
  if (platform === "win32") {
    return [{ what: "Windows Authenticode signing", groups: WINDOWS_CREDENTIALS }];
  }

  if (platform === "darwin") {
    return [
      { what: "macOS Developer ID signing", groups: MACOS_SIGNING },
      { what: "macOS notarisation", groups: MACOS_NOTARIZATION }
    ];
  }

  // Linux artifacts carry no embedded signature. Their integrity claim is the
  // published checksum, which the release run produces unconditionally, so there
  // is no credential to demand here.
  return [];
}

function main() {
  const platform = process.platform;
  const requirements = requirementsFor(platform);

  if (requirements.length === 0) {
    console.log(
      `Release preflight: ${platform} artifacts carry no embedded signature; ` +
        "integrity is published as SHA-256 checksums. Proceeding."
    );
    return;
  }

  const missing = requirements.filter((requirement) => satisfied(requirement.groups) === null);

  if (missing.length === 0) {
    for (const requirement of requirements) {
      const group = satisfied(requirement.groups);
      console.log(`Release preflight: ${requirement.what} configured via ${group.label}.`);
    }
    return;
  }

  console.error(
    `\nRelease build refused: this ${platform} host cannot produce a distributable artifact.\n`
  );

  for (const requirement of missing) {
    console.error(`  ${requirement.what} — set one of:\n${describe(requirement.groups)}\n`);
  }

  console.error(
    "  An unsigned build carries no provenance and must not be distributed\n" +
      "  (docs/RELEASES.md). To produce one for local testing instead, run:\n\n" +
      "      pnpm package\n"
  );

  process.exit(1);
}

main();
