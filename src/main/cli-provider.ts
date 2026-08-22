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
 *      argv carries fixed flags this file holds, and a model name the validator
 *      already constrained to characters that cannot spell one.
 *
 *   4. **The environment is rebuilt, not inherited.** `process.env` in this
 *      process holds whatever launched the app, which on a developer's machine
 *      routinely includes API keys for other services. A child gets a short
 *      fixed list of variables it cannot run without and nothing else.
 *
 *   5. **Execution is bounded** in time and in output, and killed on both.
 *
 *   6. **The invocation is the leanest one the tool offers.** A coding CLI
 *      started with no arguments comes up as if a person were about to sit in
 *      front of it: it loads the MCP servers, skills, plugins, hooks, and
 *      project memory its user configured for interactive work, mounts its whole
 *      built-in tool set, and then runs an agentic loop that resends all of that
 *      on every turn. None of that is what this adapter asked for, so all of it
 *      is context the user pays for and never sees. Each supported program is
 *      asked instead for exactly what this adapter uses: one non-interactive
 *      turn, no configuration, and no tools it was not given on purpose.
 *
 *   7. **The only tools are OpenStrawberry's own.** A run may be handed the
 *      browser, which arrives as one MCP server this application is hosting and
 *      nothing else: the tool's built-in set stays off, its own configured MCP
 *      servers stay ignored, and the allowlist names this server so a call is
 *      answered rather than waiting on a prompt no one can see. The file that
 *      carries the endpoint is named in argv; the token inside it is not,
 *      because of rule 3.
 */
import { MCP_SERVER_NAME } from "../shared/mcp.js";
import type { ProviderResult } from "../shared/provider-request.js";

/** How long a local tool may run before it is killed. */
export const CLI_TIMEOUT_MS = 120_000;

/**
 * The budget when the run was handed the browser.
 *
 * A one-shot call is a single turn, and two minutes is generous for one. A run
 * with tools is a loop by construction - read a page, decide, navigate, read
 * again - and several of those turns stop dead waiting for a person to answer an
 * approval. Killing that at the one-shot budget would report a timeout for a run
 * whose only fault was that the user had not looked at the screen yet.
 */
export const CLI_BROWSER_TIMEOUT_MS = 600_000;

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

/**
 * How one program is asked for a single plain answer.
 *
 * `args` is a constant. Nothing a user typed reaches it, so the table can be
 * read as the complete command line the app will ever build, and reviewed for
 * what it turns off without reasoning about the caller.
 */
interface CliInvocation {
  readonly args: readonly string[];
  /** The flag that names a model, for a tool that takes one. */
  readonly modelFlag: string | null;
  /**
   * The invocation to use instead when the run has the browser. Null for a
   * program that has no checked way to be handed one server and only that one.
   */
  readonly browser: BrowserInvocation | null;
}

/**
 * How one program is handed exactly one MCP server and no other tool.
 *
 * `args` replaces the lean list rather than extending it, because the two are
 * not compatible: the flag that turns a coding CLI's whole configuration off
 * turns its MCP servers off with it, including one named on the command line.
 * Writing the whole line out is what makes that readable.
 */
interface BrowserInvocation {
  readonly args: readonly string[];
  /** The flag the session config file's path follows. */
  readonly configFlag: string;
}

/**
 * The lean invocation for each program that has one.
 *
 * Only tools whose flags have been checked against the installed CLI appear
 * here. A program that is absent is spawned bare, exactly as before, because a
 * guessed flag does not degrade a route, it breaks it: an unrecognised option
 * makes the tool exit non-zero before it does any work, and the run reports a
 * command that failed rather than an answer.
 *
 * What the flags buy, in both entries: no MCP servers, no skills or plugins, no
 * hooks, no project memory, no session written to disk, and no tools. That last
 * one is also what holds the call to a single turn, since a tool call is the
 * only thing that would send the tool round again with the whole context
 * resent - and a tool that cannot call a tool cannot touch the machine while it
 * answers, which is the posture every browser action here already has.
 *
 * Claude Code's empty tool list is written `--tools=` rather than as a separate
 * empty argument: its parser reads a trailing empty argv entry as a missing one
 * and refuses the flag.
 */
export const CLI_INVOCATIONS: Readonly<Record<string, CliInvocation>> = {
  claude: {
    args: [
      "--print",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
      // Moves per-machine detail out of the system prompt, so repeated runs from
      // this app share a prefix the provider can serve from cache.
      "--exclude-dynamic-system-prompt-sections",
      "--tools="
    ],
    modelFlag: "--model",
    /*
     * `--safe-mode` is absent here, and its absence is the whole reason this is
     * a second list rather than three more flags appended to the first. It
     * disables every customisation the tool has, and MCP servers are one of
     * them - including a server named by `--mcp-config` on the same command
     * line. Checked against the installed CLI rather than reasoned about: with
     * it, the endpoint this app is hosting is never contacted at all.
     *
     * What replaces it is the same refusals stated one at a time.
     * `--strict-mcp-config` ignores every MCP server the user configured, so the
     * only one loaded is this application's. `--setting-sources=` loads no user,
     * project, or local settings, which is where hooks and plugins are named.
     * `--disable-slash-commands` drops skills. `--tools=` leaves the built-in set
     * empty, so the file system and the shell stay out of reach and the browser
     * is the only thing the run can touch.
     *
     * `--allowedTools` names the server rather than each tool: a tool that is
     * not pre-allowed raises a permission prompt, and in a non-interactive run
     * there is nobody at that prompt. The consent that matters is not skipped by
     * this - it is moved to where the user can actually see it, which is
     * OpenStrawberry's own approval gate, on the far side of the socket.
     */
    browser: {
      args: [
        "--print",
        "--strict-mcp-config",
        "--setting-sources=",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--exclude-dynamic-system-prompt-sections",
        "--tools=",
        "--allowedTools",
        `mcp__${MCP_SERVER_NAME}`
      ],
      configFlag: "--mcp-config"
    }
  },
  codex: {
    args: [
      // Without this the tool comes up as a full-screen interactive session and
      // sits there until the timeout kills it.
      "exec",
      "--ignore-user-config",
      "--ignore-rules",
      // The working directory is a scratch folder, which is not a repository.
      "--skip-git-repo-check",
      "--ephemeral",
      // Codex has no way to run with no tools at all, so the next best thing is
      // a sandbox that cannot write.
      "--sandbox",
      "read-only"
    ],
    modelFlag: "--model",
    /*
     * Codex reads its MCP servers from `config.toml` and takes no flag naming a
     * config file, so the only way to hand it one would be `-c` overrides in
     * argv - which would put the session's bearer token on a command line every
     * process listing on the machine can read. Rule 3 is not negotiable for a
     * convenience, so this route runs without the browser until the tool offers
     * a way that does not require it.
     */
    browser: null
  }
};

/**
 * Whether a program can be handed the browser.
 *
 * Asked before a session is opened, so a route that cannot use one never mints a
 * token, never writes a config file, and never binds a socket.
 */
export function supportsBrowserTools(command: string): boolean {
  return CLI_INVOCATIONS[programName(command)]?.browser != null;
}

/**
 * Whether a model name may be placed in argv.
 *
 * `requireModelId` has already constrained this at the IPC boundary, and this
 * charset is the same one - checked again here because the rule that matters is
 * that a value cannot be read as a flag, and a rule enforced only where it was
 * first written is one a later caller can walk around. A name must open with a
 * letter or digit, so no spelling of it begins with a dash.
 */
export function isPassableModel(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(model);
}

/**
 * The argv one call is made with.
 *
 * Empty for a program with no entry in the table, which is the bare spawn this
 * module did before. A model is appended only when the tool takes one, one was
 * named, and the name cannot be read as a flag; anything else falls back to the
 * tool's own default rather than refusing the run over a setting.
 *
 * A config path selects the browser invocation. It is the only value here that
 * is not a constant of this file, and it is a path this application minted under
 * its own data directory - never anything a user or a model typed.
 */
export function cliArguments(
  command: string,
  model: string | null,
  mcpConfigPath: string | null = null
): readonly string[] {
  const invocation = CLI_INVOCATIONS[programName(command)];
  if (invocation === undefined) return [];

  const browser = invocation.browser;
  const base: readonly string[] =
    mcpConfigPath === null || browser === null
      ? invocation.args
      : [...browser.args, browser.configFlag, mcpConfigPath];

  const named = (model ?? "").trim();
  if (invocation.modelFlag === null || named.length === 0 || !isPassableModel(named)) {
    return base;
  }

  return [...base, invocation.modelFlag, named];
}

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
  /** Overrides the tool's own default, when it takes one. Null leaves it alone. */
  readonly model?: string | null;
  /** A neutral directory. Never a user's documents or the app's own install. */
  readonly cwd: string;
  readonly spawn: SpawnPort;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Injected so the timeout is testable without waiting. */
  readonly timeoutMs?: number;
  /**
   * The MCP session config to hand the tool, or null for a call with no tools.
   *
   * Supplying one both selects the browser invocation and lifts the time budget,
   * because those two facts are the same fact: a run with tools is a loop, and a
   * loop that stops for a person's decision is not a hung one.
   */
  readonly mcpConfigPath?: string | null;
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

  // A config path is only honoured for a program that has a checked browser
  // invocation, so a caller cannot hand one to a tool that would read it as a
  // stray argument.
  const mcpConfigPath =
    options.mcpConfigPath != null && supportsBrowserTools(options.command)
      ? options.mcpConfigPath
      : null;

  let child: SpawnedProcess;
  try {
    /*
     * The prompt still goes in on stdin. argv is the fixed invocation from the
     * table above, which is not assembled from anything a user typed - the one
     * value that comes from settings is a model name, and it arrives having
     * already been constrained to characters that cannot spell a flag.
     */
    child = options.spawn(
      options.command,
      cliArguments(options.command, options.model ?? null, mcpConfigPath),
      {
        cwd: options.cwd,
        env: environment,
        shell: false,
        windowsHide: true
      }
    );
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

    const timer = setTimeout(
      () => {
        stop();
        finish({ ok: false, code: "timeout" });
      },
      options.timeoutMs ??
        (mcpConfigPath === null ? CLI_TIMEOUT_MS : CLI_BROWSER_TIMEOUT_MS)
    );

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
