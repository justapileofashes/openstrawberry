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
}

/**
 * Expands the `!define`s a script declares about itself.
 *
 * The registry paths below are assembled from defines, so comparing the raw
 * text of a write against the raw text of a delete would call
 * `${OPENSTRAWBERRY_CAPABILITIES_KEY}` unrelated to `${OPENSTRAWBERRY_CLIENT_KEY}`
 * when one is literally built from the other. Defines electron-builder supplies
 * are left alone: they appear identically on both sides, so they compare fine
 * unexpanded.
 */
function expandDefines(source) {
  const defines = new Map();
  for (const [, name, value] of source.matchAll(/^\s*!define\s+(\w+)\s+"([^"]*)"/gmu)) {
    defines.set(name, value);
  }

  const expand = (value) => {
    let current = value;
    for (let pass = 0; pass < defines.size + 1; pass += 1) {
      const next = current.replace(/\$\{(\w+)\}/gu, (whole, name) => defines.get(name) ?? whole);
      if (next === current) break;
      current = next;
    }
    return current;
  };

  return expand;
}

/**
 * Checks the Windows installer script, as a script rather than as a filename.
 *
 * This exists because every way it can break is quiet. The registration it
 * performs is what puts OpenStrawberry in Settings > Default apps; nothing in a
 * build, a test, or a launch touches it, and its absence looks exactly like a
 * successful install right up until someone opens Default apps and finds
 * nothing there. Four failures are worth naming:
 *
 *   - The script is not referenced at all. `nsis.include` is optional, and an
 *     installer that includes nothing builds and installs perfectly.
 *   - A registry root is hardcoded. The installer is per-user, so a write to
 *     HKLM fails for want of elevation - and NSIS does not abort on a failed
 *     registry write, so the installer still reports success.
 *   - A key is created on install and not removed on uninstall, leaving a
 *     browser in the machine's Default apps list that is no longer installed.
 *   - `description` is dropped from package.json, which turns `APP_DESCRIPTION`
 *     into literal text inside the registration rather than a description.
 */
function verifyInstallerScript(build, manifest) {
  console.log("\nValidating the Windows installer script\n");

  const problems = [];
  const configured = build.nsis?.include;

  if (typeof configured !== "string") {
    problems.push(
      "nsis.include is not set, so the installer registers nothing with Windows " +
        "and the app cannot appear in Default apps"
    );
    return problems;
  }

  let source;
  try {
    source = readFileSync(configured, "utf8");
  } catch {
    problems.push(`nsis.include names ${configured}, which does not exist`);
    return problems;
  }

  for (const macro of ["customInstall", "customUnInstall"]) {
    if (!new RegExp(`^\\s*!macro\\s+${macro}\\b`, "mu").test(source)) {
      problems.push(`${configured} defines no ${macro} macro, so electron-builder skips it silently`);
    }
  }

  if (typeof manifest.description !== "string" || manifest.description === "") {
    problems.push("package.json has no description, which APP_DESCRIPTION interpolates into the registration");
  }

  // The name in `Software\RegisteredApplications` is also the name the app puts
  // in its Settings deep link, and the two live in different languages in
  // different files. Nothing at runtime would notice them drifting: Settings
  // answers an unrecognised name by opening the undifferentiated list, which is
  // exactly what the link did before it named anything.
  const navigation = readFileSync("src/shared/navigation.ts", "utf8");
  const registeredByInstaller = /^\s*!define\s+OPENSTRAWBERRY_CLIENT\s+"([^"]*)"/mu.exec(source);
  const registeredByApp = /WINDOWS_REGISTERED_APPLICATION\s*=\s*"([^"]*)"/u.exec(
    readFileSync("src/shared/default-browser.ts", "utf8")
  );

  if (registeredByInstaller === null) {
    problems.push(`${configured} defines no OPENSTRAWBERRY_CLIENT to register the app under`);
  } else if (registeredByApp === null) {
    problems.push("src/shared/default-browser.ts declares no WINDOWS_REGISTERED_APPLICATION");
  } else if (registeredByInstaller[1] !== registeredByApp[1]) {
    problems.push(
      `the installer registers "${registeredByInstaller[1]}" but the app links to ` +
        `"${registeredByApp[1]}", so its Settings link opens the full application list`
    );
  }

  // The file types the installer claims must be the ones the app will render.
  // This is the sharpest edge in the whole registration: an extension claimed
  // here and not honoured there means someone picks OpenStrawberry for their
  // .html files and gets an empty tab on every double-click, and nothing in a
  // build or a test would say so - the registry is right, the code is right,
  // and only the pair is wrong.
  const claimed = [...source.matchAll(/FileAssociations"\s+"(\.[a-z]+)"/gu)].map((m) => m[1]).sort();
  const rendered = /LOCAL_DOCUMENT_EXTENSIONS\s*=\s*\[([^\]]*)\]/u.exec(navigation);

  if (rendered === null) {
    problems.push("src/shared/navigation.ts declares no LOCAL_DOCUMENT_EXTENSIONS");
  } else {
    const honoured = [...rendered[1].matchAll(/"(\.[a-z]+)"/gu)].map((m) => m[1]).sort();
    const missing = claimed.filter((extension) => !honoured.includes(extension));
    const unclaimed = honoured.filter((extension) => !claimed.includes(extension));

    if (missing.length > 0) {
      problems.push(
        `${configured} registers ${missing.join(", ")}, which the app will not open - ` +
          "choosing OpenStrawberry for those files would open an empty tab"
      );
    }
    if (unclaimed.length > 0) {
      problems.push(
        `the app opens ${unclaimed.join(", ")} but the installer does not register it, ` +
          "so Windows never offers OpenStrawberry for those files"
      );
    }
  }

  const expand = expandDefines(source);
  const [install = "", uninstall = ""] = source.split(/^\s*!macro\s+customUnInstall\b/mu);

  const written = [];
  for (const [, root, key] of install.matchAll(/^\s*WriteReg\w+\s+(\S+)\s+"([^"]*)"/gmu)) {
    if (root !== "SHELL_CONTEXT") {
      problems.push(`${key} is written to ${root} rather than SHELL_CONTEXT, which a per-user install cannot reach`);
    }
    written.push(expand(key));
  }

  if (written.length === 0) {
    problems.push(`${configured} writes no registry keys at all`);
  }

  const removed = [];
  for (const [, root, key] of uninstall.matchAll(/^\s*DeleteReg\w+\s+(?:\/ifempty\s+)?(\S+)\s+"([^"]*)"/gmu)) {
    if (root !== "SHELL_CONTEXT") {
      problems.push(`${key} is removed from ${root} rather than SHELL_CONTEXT`);
    }
    removed.push(expand(key));
  }

  // electron-builder's own uninstaller deletes the Add/Remove Programs entry
  // wholesale, so a value this script adds to it needs no removal here.
  const removedByElectronBuilder = expand("${UNINSTALL_REGISTRY_KEY}");

  for (const key of new Set(written)) {
    if (key === removedByElectronBuilder) continue;
    const covered = removed.some((gone) => key === gone || key.startsWith(`${gone}\\`));
    if (!covered) problems.push(`${key} is created on install and never removed on uninstall`);
  }

  return problems;
}

const installerProblems = verifyInstallerScript(build, JSON.parse(readFileSync("package.json", "utf8")));

for (const problem of installerProblems) console.log(`  FAIL  ${problem}`);
if (installerProblems.length === 0) {
  console.log(`  ok    ${build.nsis.include} registers OpenStrawberry with Windows and unregisters it cleanly`);
}

if (failures > 0 || installerProblems.length > 0) process.exit(1);

console.log("\nEvery platform block validates, including those this machine cannot build.\n");
