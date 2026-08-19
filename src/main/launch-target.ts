/**
 * What the desktop asked this process to open.
 *
 * Windows starts the browser three ways: with nothing, with a URL after a link
 * click, and with a path after someone double-clicks an HTML file. The third is
 * new, and it is the reason this module exists: deciding it needs the disk, and
 * `../shared/navigation.js` must stay pure so the renderer can bundle it.
 *
 * Arguments are attacker-adjacent. Anything on the machine can invoke the
 * binary with anything, so nothing here trusts the string it was handed: the
 * shape is judged by the shared policy, the path is resolved before it is
 * looked at, and the result is judged by the shared policy a second time - the
 * first time as a path, the second as the URL it became.
 *
 * No Electron import, so the whole decision is unit testable.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isLocalDocumentUrl, localDocumentArgument, urlFromCommandLine } from "../shared/navigation.js";

/**
 * The URL to open for a command line, or null when it asked for nothing.
 *
 * A link beats a file when both are somehow present. That ordering is not
 * arbitrary: `urlFromCommandLine` is the older, narrower path, and a launch
 * carrying a real URL is unambiguous about what the person clicked.
 */
export function launchTargetFromCommandLine(argv: readonly string[]): string | null {
  const url = urlFromCommandLine(argv);
  if (url !== null) return url;

  const argument = localDocumentArgument(argv);
  if (argument === null) return null;

  return localDocumentUrl(argument);
}

/**
 * Turns a path into a `file:` URL, or null if it is not a document to open.
 *
 * The existence check is not politeness. Without it a mistyped association, a
 * moved file, or a stale shortcut would open a tab showing a Chromium error
 * page, and the person would blame the browser for a file the OS lost. Refusing
 * to open a tab at all is the better failure.
 *
 * `isFile` rather than `exists`: a directory is a perfectly real path, and
 * rendering a directory listing is not what a `.html` association promised.
 */
function localDocumentUrl(argument: string): string | null {
  let absolute: string;
  try {
    absolute = resolve(argument);
  } catch {
    return null;
  }

  try {
    if (!statSync(absolute).isFile()) return null;
  } catch {
    // Missing, unreadable, or a path this process may not stat. All the same
    // answer: there is nothing here to show.
    return null;
  }

  const url = pathToFileURL(absolute).href;

  // Judged again, now that it is a URL. `resolve` can turn an argument that
  // passed the extension check into something that no longer does - a trailing
  // dot or space is dropped on Windows - and the URL is what actually gets
  // loaded, so the URL is what has to satisfy the policy.
  return isLocalDocumentUrl(url) ? url : null;
}
