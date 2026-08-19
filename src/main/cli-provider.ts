/**
 * Running a local coding CLI as an agent's model.
 *
 * This is the only code in OpenStrawberry that starts a process, so the rules
 * are stated here in full and each one is enforced rather than assumed.
 *
 *   1. **No shell, ever.** The program is spawned with an argv array and
 *      `shell: false`. A shell is what turns a program name into a place where
 *      `;`, `|`, and `$(...)` mean something, and `requireCommand` already
 *      refuses those characters - but the charset is defence in depth behind
 *      this, not instead of it.
 *
 *   2. **The executable is allowlisted by name.** A user may point at a program
 *      anywhere on disk, because a CLI installed under a version manager is not
 *      on a predictable path - but the file's *base name* must be one of the
 *      tools this app ships support for. Configuring a path is the user's
 *      authorisation for that program; it is not authorisation for an arbitrary
 *      binary.
 *
 *   3. **The prompt goes in on stdin, never in argv.** Command lines are visible
 *      to any process listing on the machine, so a task typed into the composer
 *      would be readable by every other user on a shared box. stdin is not.
 *
 *   4. **The environment is rebuilt, not inherited.** `process.env` in this
 *      process holds whatever launched the app, which on a developer's machine
 *      routinely includes API keys for other services. A child gets a short
 *      fixed list of variables it cannot run without and nothing else.
 *
 *   5. **Execution is bounded** in time and in output, and killed on both.
 */
import type { ProviderResult } from "../shared/provider-request.js";

/** How long a local tool may run before it is killed. */
export const CLI_TIMEOUT_MS = 120_000;

/** How much output is kept. Past this the process is killed. */
export const MAX_CLI_OUTPUT_BYTES = 1024 * 1024;

/**
 * Programs this app ships support for.
 *
 * The allowlist is on the base name, so `/opt/homebrew/bin/claude` and
 * `C:\tools\claude.exe` are both the tool called `claude`, and something else
 * renamed to sit at a configured path is not.
 */
export const ALLOWED_CLI_PROGRAMS: readonly string[] = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "antigravity",
  "qwen",
  "kimi"
];

/**
 * Environment variables a child is given.
 *
 * Everything a program needs to find itself and write a temporary file, and
 * nothing that carries a secret. Notably absent: every `*_API_KEY`, `*_TOKEN`,
 * and `AWS_*` variable that a developer's shell is likely to hold.
 */
const INHERITED_ENV: readonly string[] = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "COMSPEC",
  "PATHEXT"
];

/** The base name of a program path, without a Windows executable extension. */
export function programName(command: string): string {
  const segments = command.split(/[/\\]/u);
  const base = segments[segments.length - 1] ?? "";
  return base.replace(/\.(exe|cmd|bat|com)$/iu, "").toLowerCase();
}

/** Whether a configured command names a program this app supports. */
export function isAllowedCommand(command: string): boolean {
  const name = programName(command.trim());
  return name.length > 0 && ALLOWED_CLI_PROGRAMS.includes(name);
}

/**
 * The environment a child is given.
 *
 * Built from a fixed list rather than filtered from `process.env`, so a variable
 * added to the parent later is absent by default rather than present until
 * someone remembers to exclude it.
 */
export function childEnvironment(
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const name of INHERITED_ENV) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }

  return environment;
}

/** One running child, as this module needs it. */
export interface SpawnedProcess {
  readonly stdout: { readonly on: (event: "data", handler: (chunk: Uint8Array) => void) => void };
  readonly stderr: { readonly on: (event: "data", handler: (chunk: Uint8Array) => void) => void };
  readonly stdin: { readonly end: (text: string) => void };
  readonly on: (
    event: "close" | "error",
    handler: (codeOrError: number | null | Error) => void
  ) => void;
  readonly kill: () => void;
}

/** The spawn call, injected so the whole path is testable without a process. */
export type SpawnPort = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly shell: false;
    readonly windowsHide: true;
  }
) => SpawnedProcess;

export interface CliCallOptions {
  /** Already validated by `requireCommand`; re-checked against the allowlist. */
  readonly command: string;
  readonly prompt: string;
  /** A neutral directory. Never a user's documents or the app's own install. */
  readonly cwd: string;
  readonly spawn: SpawnPort;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Injected so the timeout is testable without waiting. */
  readonly timeoutMs?: number;
}

/**
 * Runs a local CLI and returns what it printed.
 *
 * Never throws. Every outcome - refused, failed to start, exited badly, timed
 * out, cancelled, silent - is a code the caller turns into wording it holds.
 * stderr is captured to decide success but is deliberately *not* returned: a
 * tool's diagnostics are not something to put in a run log unread, and they can
 * echo whatever was on stdin.
 */
export async function callCli(options: CliCallOptions): Promise<ProviderResult> {
  if (!isAllowedCommand(options.command)) {
    return { ok: false, code: "command-not-allowed" };
  }

  if (options.signal?.aborted === true) return { ok: false, code: "cancelled" };

  const environment = childEnvironment(options.environment ?? process.env);

  let child: SpawnedProcess;
  try {
    /*
     * No arguments. The prompt goes in on stdin, and a tool that needs flags to
     * read stdin is one this app does not yet support - which is a smaller
     * problem than assembling a command line from anything a user typed.
     */
    child = options.spawn(options.command, [], {
      cwd: options.cwd,
      env: environment,
      shell: false,
      windowsHide: true
    });
  } catch {
    return { ok: false, code: "command-failed" };
  }

  return new Promise<ProviderResult>((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    let killedForSize = false;

    const finish = (result: ProviderResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const stop = (): void => {
      try {
        child.kill();
      } catch {
        // Already gone; the close handler still settles the promise.
      }
    };

    const timer = setTimeout(() => {
      stop();
      finish({ ok: false, code: "timeout" });
    }, options.timeoutMs ?? CLI_TIMEOUT_MS);

    const onAbort = (): void => {
      stop();
      finish({ ok: false, code: "cancelled" });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      total += chunk.byteLength;
      // Checked before the chunk is retained, so a tool that never stops
      // printing costs one chunk over the cap rather than all of it.
      if (total > MAX_CLI_OUTPUT_BYTES) {
        killedForSize = true;
        stop();
        finish({ ok: false, code: "too-large" });
        return;
      }
      chunks.push(chunk);
    });

    // Read so the pipe cannot fill and block the child, then discarded.
    child.stderr.on("data", () => undefined);

    child.on("error", () => finish({ ok: false, code: "command-failed" }));

    child.on("close", (code) => {
      if (killedForSize) return;
      if (typeof code === "number" && code !== 0) {
        return finish({ ok: false, code: "command-failed" });
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const text = new TextDecoder().decode(bytes).trim();
      finish(
        text.length > 0 ? { ok: true, text } : { ok: false, code: "no-output" }
      );
    });

    try {
      child.stdin.end(options.prompt);
    } catch {
      stop();
      finish({ ok: false, code: "command-failed" });
    }
  });
}
