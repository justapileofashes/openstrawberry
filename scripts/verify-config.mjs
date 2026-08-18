#!/usr/bin/env node
/**
 * Validates every platform block in the packaging configuration, including the
 * ones this machine cannot build.
 *
 * This exists because of a bug it would have caught. `signingHashAlgorithms`
 * sat directly on `win`; electron-builder 26 moved the Windows signtool
 * settings into `win.signtoolOptions`, and the schema is validated before
 * anything is packaged - so the effect was not a signing problem but a total
 * refusal to build, with the message "configuration.win should be one of these:
 * null". The repository could not produce an installer at all, and nothing said
 * so until someone tried.
 *
 * The failure mode that matters is the one that stays hidden: a break in the
 * `mac` or `linux` block is invisible on a Windows machine, and would surface
 * only on a release runner, at the moment it is most expensive. Checking the
 * whole configuration against the schema costs nothing and makes a
 * platform-specific break a normal test failure.
 *
 * It reads the schema shipped inside `app-builder-lib` rather than a copy, so
 * it cannot fall out of step with the version actually installed - which is
 * precisely the thing that went wrong.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const CONFIG_BLOCKS = [
  ["win", "WindowsConfiguration"],
  ["mac", "MacConfiguration"],
  ["linux", "LinuxConfiguration"],
  ["nsis", "NsisOptions"],
  ["dmg", "DmgOptions"],
  ["deb", "DebOptions"],
  ["rpm", "LinuxTargetSpecificOptions"],
  ["appImage", "AppImageOptions"]
];

function loadSchema() {
  const matches = globSync("node_modules/.pnpm/**/app-builder-lib/scheme.json");
  if (matches.length === 0) {
    console.error("Could not find app-builder-lib's schema. Is electron-builder installed?");
    process.exit(1);
  }
  return JSON.parse(readFileSync(matches[0], "utf8"));
}

/**
 * Every property name a definition accepts.
 *
 * Follows `allOf` and `anyOf` composition, because electron-builder's platform
 * configurations inherit shared options that way; reading only `properties`
 * would report inherited options as unknown and make this check cry wolf.
 */
function propertiesOf(schema, name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);

  const definition = schema.definitions[name];
  if (definition === undefined) return new Set();

  const names = new Set(Object.keys(definition.properties ?? {}));

  for (const branch of [...(definition.allOf ?? []), ...(definition.anyOf ?? [])]) {
    if (typeof branch.$ref === "string") {
      for (const inherited of propertiesOf(schema, branch.$ref.replace("#/definitions/", ""), seen)) {
        names.add(inherited);
      }
    }
    for (const own of Object.keys(branch.properties ?? {})) names.add(own);
  }

  return names;
}

const schema = loadSchema();
const build = JSON.parse(readFileSync("package.json", "utf8")).build ?? {};

console.log("\nValidating packaging configuration against the installed schema\n");

let failures = 0;

for (const [key, definition] of CONFIG_BLOCKS) {
  const configured = build[key];
  if (configured === undefined || typeof configured !== "object") continue;

  const allowed = propertiesOf(schema, definition);
  if (allowed.size === 0) {
    console.log(`  warn  ${key}: the schema has no definition named ${definition}`);
    continue;
  }

  const unknown = Object.keys(configured).filter((name) => !allowed.has(name));

  if (unknown.length === 0) {
    console.log(`  ok    ${key}: ${Object.keys(configured).length} option(s) recognised`);
    continue;
  }

  failures += unknown.length;
  for (const name of unknown) {
    console.log(`  FAIL  ${key}.${name} is not a ${definition} option`);
  }
}

if (failures > 0) {
  console.log(
    `\n${failures} unrecognised option(s). electron-builder validates the whole ` +
      "configuration before packaging, so this refuses every target, not just the " +
      "one the option belongs to.\n"
  );
  process.exit(1);
}

console.log("\nEvery platform block validates, including those this machine cannot build.\n");
