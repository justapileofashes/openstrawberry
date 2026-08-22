import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CLI_PROGRAMS,
  CLI_INVOCATIONS,
  callCli,
  childEnvironment,
  cliArguments,
  isAllowedCommand,
  isPassableModel,
  programName,
  supportsBrowserTools,
  CLI_BROWSER_TIMEOUT_MS,
  CLI_TIMEOUT_MS,
  type SpawnPort,
  type SpawnedProcess
} from "./cli-provider.js";

/** A stand-in for a spawned process, driven by the test. */
class FakeChild implements SpawnedProcess {
  public killed = false;
  public stdinText = "";

  private readonly handlers = new Map<string, ((value: never) => void)[]>();

  public readonly stdout = {
    on: (event: "data", handler: (chunk: Uint8Array) => void) => {
      this.listen(`stdout:${event}`, handler as (value: never) => void);
    }
  };

  public readonly stderr = {
    on: (event: "data", handler: (chunk: Uint8Array) => void) => {
      this.listen(`stderr:${event}`, handler as (value: never) => void);
    }
  };

  public readonly stdin = {
    end: (text: string) => {
      this.stdinText = text;
    }
  };

  public on(
    event: "close" | "error",
    handler: (codeOrError: number | null | Error) => void
  ): void {
    this.listen(event, handler as (value: never) => void);
  }

  public kill(): void {
    this.killed = true;
  }

  private listen(key: string, handler: (value: never) => void): void {
    const existing = this.handlers.get(key) ?? [];
    existing.push(handler);
    this.handlers.set(key, existing);
  }

  private emit(key: string, value: unknown): void {
    for (const handler of this.handlers.get(key) ?? []) {
      (handler as (v: unknown) => void)(value);
    }
  }

  public print(text: string): void {
    this.emit("stdout:data", new TextEncoder().encode(text));
  }

  public printBytes(count: number): void {
    this.emit("stdout:data", new Uint8Array(count));
  }

  public warn(text: string): void {
    this.emit("stderr:data", new TextEncoder().encode(text));
  }

  public close(code: number | null): void {
    this.emit("close", code);
  }

  public fail(error: Error): void {
    this.emit("error", error);
  }
}

interface Spawned {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
}

function spawnPort(
  child: FakeChild,
  captured?: Spawned[]
): SpawnPort {
  return (command, args, options) => {
    captured?.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      shell: options.shell
    });
    return child;
  };
}

describe("programName", () => {
  it("takes the base name and drops a Windows extension", () => {
    expect(programName("/opt/homebrew/bin/claude")).toBe("claude");
    expect(programName("C:\\tools\\claude.exe")).toBe("claude");
    expect(programName("claude.CMD")).toBe("claude");
    expect(programName("claude")).toBe("claude");
  });
});

describe("isAllowedCommand", () => {
  it("accepts a supported tool wherever it is installed", () => {
    // A CLI under a version manager is not on a predictable path.
    for (const command of [
      "claude",
      "/opt/homebrew/bin/claude",
      "C:\\Program Files\\nodejs\\codex.exe",
      "/home/me/.local/bin/opencode"
    ]) {
      expect(isAllowedCommand(command), command).toBe(true);
    }
  });

  it("refuses a program this app ships no support for", () => {
    // Configuring a path authorises that program, not an arbitrary binary.
    for (const command of [
      "bash",
      "sh",
      "cmd",
      "powershell",
      "curl",
      "node",
      "python",
      "/bin/sh",
      "C:\\Windows\\System32\\cmd.exe",
      ""
    ]) {
      expect(isAllowedCommand(command), command).toBe(false);
    }
  });

  it("is not fooled by a supported name appearing elsewhere in the path", () => {
    expect(isAllowedCommand("/opt/claude/bin/bash")).toBe(false);
    expect(isAllowedCommand("/usr/bin/claude-wrapper")).toBe(false);
  });

  it("ships a short list", () => {
    expect(ALLOWED_CLI_PROGRAMS.length).toBeLessThanOrEqual(12);
    for (const name of ALLOWED_CLI_PROGRAMS) expect(name).toMatch(/^[a-z0-9-]+$/u);
  });
});

describe("cliArguments", () => {
  it("asks a known tool for one turn with nothing else loaded", () => {
    // The point of the flags: no MCP servers, no skills, no plugins, no hooks,
    // no project memory, and no tools - which is also what keeps the call to a
    // single turn, because a tool call is the only thing that would make the
    // tool go round again with the whole context resent.
    const args = cliArguments("/opt/homebrew/bin/claude", null);

    expect(args).toContain("--print");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--tools=");
  });

  it("does not leave a coding CLI waiting for a person", () => {
    // Started bare, Codex comes up interactive and sits there until the timeout.
    expect(cliArguments("codex", null).at(0)).toBe("exec");
  });

  it("spawns a tool with no checked invocation exactly as it did before", () => {
    // A guessed flag does not degrade a route, it breaks it: the tool exits
    // non-zero before doing any work.
    for (const command of ["gemini", "opencode", "qwen", "kimi", "antigravity"]) {
      expect(cliArguments(command, "some-model"), command).toEqual([]);
    }
  });

  it("passes a named model through, so a cheap one can sit behind a route", () => {
    expect(cliArguments("claude", "haiku").slice(-2)).toEqual(["--model", "haiku"]);
    expect(cliArguments("codex", "gpt-5").slice(-2)).toEqual(["--model", "gpt-5"]);
  });

  it("leaves the tool's own choice alone when no model is named", () => {
    // A CLI ships no default model here, so empty is the ordinary case.
    for (const model of [null, "", "   "]) {
      expect(cliArguments("claude", model)).not.toContain("--model");
    }
  });

  it("drops a model name rather than letting it be read as a flag", () => {
    // Constrained at the IPC boundary too; checked again because a rule
    // enforced only where it was written is one a later caller walks around.
    for (const model of ["--dangerously-skip-permissions", "-p", "a b", "a;b", "$(x)"]) {
      expect(cliArguments("claude", model), model).not.toContain("--model");
    }
  });

  it("only names programs this app ships support for", () => {
    for (const name of Object.keys(CLI_INVOCATIONS)) {
      expect(ALLOWED_CLI_PROGRAMS, name).toContain(name);
    }
  });
});

describe("cliArguments with the browser attached", () => {
  const CONFIG = "/data/openstrawberry/mcp-session-1.json";

  it("names the session config after the flag that loads it", () => {
    const args = cliArguments("claude", null, CONFIG);
    expect(args.slice(-2)).toEqual(["--mcp-config", CONFIG]);
  });

  it("drops --safe-mode, which disables the MCP server on the same command line", () => {
    // Checked against the installed CLI rather than reasoned about: with
    // --safe-mode present, the endpoint this app hosts is never contacted.
    const args = cliArguments("claude", null, CONFIG);
    expect(args).not.toContain("--safe-mode");
  });

  it("states one at a time every refusal --safe-mode used to cover", () => {
    const args = cliArguments("claude", null, CONFIG);

    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources=");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
  });

  it("still mounts no built-in tool, so the browser is all the run can touch", () => {
    expect(cliArguments("claude", null, CONFIG)).toContain("--tools=");
  });

  it("pre-allows this server, because nobody is at a permission prompt", () => {
    const args = cliArguments("claude", null, CONFIG);
    const index = args.indexOf("--allowedTools");

    expect(index).toBeGreaterThanOrEqual(0);
    expect(args[index + 1]).toBe("mcp__openstrawberry");
  });

  it("still passes a model through", () => {
    expect(cliArguments("claude", "haiku", CONFIG).slice(-2)).toEqual(["--model", "haiku"]);
    expect(cliArguments("claude", "haiku", CONFIG)).toContain("--mcp-config");
  });

  it("ignores a config path for a program with no checked way to load one", () => {
    // Codex reads its MCP servers from config.toml and takes no flag naming a
    // file, so the only route would put the bearer token in argv.
    expect(cliArguments("codex", null, CONFIG)).toEqual(cliArguments("codex", null));
    expect(cliArguments("gemini", null, CONFIG)).toEqual([]);
  });

  it("falls back to the lean invocation when no session was opened", () => {
    expect(cliArguments("claude", null, null)).toEqual(cliArguments("claude", null));
  });
});

describe("supportsBrowserTools", () => {
  it("answers for a program wherever it is installed", () => {
    expect(supportsBrowserTools("claude")).toBe(true);
    expect(supportsBrowserTools("/opt/homebrew/bin/claude")).toBe(true);
    expect(supportsBrowserTools("C:\\tools\\claude.exe")).toBe(true);
  });

  it("says no for every program without a checked invocation", () => {
    for (const command of ["codex", "gemini", "opencode", "qwen", "kimi", "antigravity", "nope"]) {
      expect(supportsBrowserTools(command), command).toBe(false);
    }
  });
});

describe("isPassableModel", () => {
  it("accepts the names the validator already allows", () => {
    for (const model of ["haiku", "claude-opus-5", "gpt-5", "anthropic/claude-opus-5", "qwen2.5:7b"]) {
      expect(isPassableModel(model), model).toBe(true);
    }
  });

  it("refuses anything that could be read as a flag or a second argument", () => {
    for (const model of ["-p", "--model", "", " haiku", "haiku extra", ".hidden"]) {
      expect(isPassableModel(model), model).toBe(false);
    }
  });
});

describe("childEnvironment", () => {
  it("passes through only what a program needs to run", () => {
    const environment = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/me",
      LANG: "en_GB.UTF-8"
    });

    expect(environment).toEqual({ PATH: "/usr/bin", HOME: "/home/me", LANG: "en_GB.UTF-8" });
  });

  it("drops everything that could carry a secret", () => {
    // Built from a fixed list rather than filtered, so a variable added to the
    // parent later is absent by default.
    const environment = childEnvironment({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-should-not-travel",
      OPENAI_API_KEY: "sk-should-not-travel",
      AWS_SECRET_ACCESS_KEY: "should-not-travel",
      GITHUB_TOKEN: "ghp_should-not-travel",
      SOME_FUTURE_SECRET: "should-not-travel"
    });

    expect(Object.keys(environment)).toEqual(["PATH"]);
    expect(JSON.stringify(environment)).not.toContain("should-not-travel");
  });

  it("omits a variable that is present but empty", () => {
    expect(childEnvironment({ PATH: "", HOME: "/home/me" })).toEqual({ HOME: "/home/me" });
  });
});

describe("callCli", () => {
  const base = {
    command: "claude",
    prompt: "summarise this",
    cwd: "/tmp/openstrawberry",
    environment: { PATH: "/usr/bin" }
  };

  it("returns what the tool printed", async () => {
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });

    child.print("the answer\n");
    child.close(0);

    await expect(promise).resolves.toEqual({ ok: true, text: "the answer" });
  });

  it("never uses a shell", async () => {
    // A shell is what would turn a program name into a place where ; and | mean
    // something.
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({ ...base, spawn: spawnPort(child, captured) });

    child.print("x");
    child.close(0);
    await promise;

    expect(captured[0]?.shell).toBe(false);
  });

  it("passes the prompt on stdin and never in argv", async () => {
    // A command line is visible to any process listing on the machine. argv
    // carries the fixed invocation and nothing the user typed.
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({
      ...base,
      prompt: "a private question",
      spawn: spawnPort(child, captured)
    });

    child.print("x");
    child.close(0);
    await promise;

    expect(JSON.stringify(captured[0]?.args)).not.toContain("private");
    expect(child.stdinText).toBe("a private question");
  });

  it("spawns with the lean invocation for the program named", async () => {
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({ ...base, model: "haiku", spawn: spawnPort(child, captured) });

    child.print("x");
    child.close(0);
    await promise;

    expect(captured[0]?.args).toEqual(cliArguments("claude", "haiku"));
  });

  it("hands the session config to a tool that can load one", async () => {
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({
      ...base,
      mcpConfigPath: "/data/mcp-session-1.json",
      spawn: spawnPort(child, captured)
    });

    child.print("x");
    child.close(0);
    await promise;

    expect(captured[0]?.args).toContain("--mcp-config");
    expect(captured[0]?.args).toContain("/data/mcp-session-1.json");
  });

  it("never puts the token itself on the command line", async () => {
    // The path is in argv; the bearer token is inside a file written owner-only.
    // Rule 3 does not stop being true because the value is a session secret
    // rather than a prompt.
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({
      ...base,
      mcpConfigPath: "/data/mcp-session-1.json",
      spawn: spawnPort(child, captured)
    });

    child.print("x");
    child.close(0);
    await promise;

    expect(JSON.stringify(captured[0]?.args)).not.toContain("Bearer");
    expect(JSON.stringify(captured[0]?.args)).not.toContain("Authorization");
  });

  it("drops a config path a program has no checked way to load", async () => {
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({
      ...base,
      command: "codex",
      mcpConfigPath: "/data/mcp-session-1.json",
      spawn: spawnPort(child, captured)
    });

    child.print("x");
    child.close(0);
    await promise;

    expect(JSON.stringify(captured[0]?.args)).not.toContain("mcp-session-1");
  });

  it("gives a run with tools a longer budget than a single turn", async () => {
    // A loop that stops for a person's decision is not a hung one.
    expect(CLI_BROWSER_TIMEOUT_MS).toBeGreaterThan(CLI_TIMEOUT_MS);

    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const promise = callCli({
        ...base,
        mcpConfigPath: "/data/mcp-session-1.json",
        spawn: spawnPort(child)
      });

      vi.advanceTimersByTime(CLI_TIMEOUT_MS + 1000);
      expect(child.killed).toBe(false);

      vi.advanceTimersByTime(CLI_BROWSER_TIMEOUT_MS);
      await expect(promise).resolves.toEqual({ ok: false, code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the child a rebuilt environment", async () => {
    const child = new FakeChild();
    const captured: Spawned[] = [];
    const promise = callCli({
      ...base,
      environment: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-leaked" },
      spawn: spawnPort(child, captured)
    });

    child.print("x");
    child.close(0);
    await promise;

    expect(JSON.stringify(captured[0]?.env)).not.toContain("sk-ant-leaked");
  });

  it("refuses a program that is not on the allowlist, without spawning", async () => {
    const spawn = vi.fn();
    const result = await callCli({
      ...base,
      command: "/bin/sh",
      spawn: spawn as unknown as SpawnPort
    });

    expect(result).toEqual({ ok: false, code: "command-not-allowed" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a non-zero exit as a failure", async () => {
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });

    child.print("partial");
    child.close(2);

    await expect(promise).resolves.toEqual({ ok: false, code: "command-failed" });
  });

  it("reports a tool that printed nothing", async () => {
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });
    child.close(0);

    await expect(promise).resolves.toEqual({ ok: false, code: "no-output" });
  });

  it("reports a spawn that failed", async () => {
    const result = await callCli({
      ...base,
      spawn: (() => {
        throw new Error("ENOENT");
      }) as unknown as SpawnPort
    });

    expect(result).toEqual({ ok: false, code: "command-failed" });
  });

  it("reports a child that errored after starting", async () => {
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });

    child.fail(new Error("EPIPE"));

    await expect(promise).resolves.toEqual({ ok: false, code: "command-failed" });
  });

  it("kills a tool that prints past the cap", async () => {
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });

    for (let index = 0; index < 20; index += 1) child.printBytes(128 * 1024);

    await expect(promise).resolves.toEqual({ ok: false, code: "too-large" });
    expect(child.killed).toBe(true);
  });

  it("kills a tool that never finishes", async () => {
    const child = new FakeChild();
    const result = await callCli({ ...base, spawn: spawnPort(child), timeoutMs: 5 });

    expect(result).toEqual({ ok: false, code: "timeout" });
    expect(child.killed).toBe(true);
  });

  it("kills a tool when the run is cancelled", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const promise = callCli({ ...base, spawn: spawnPort(child), signal: controller.signal });

    controller.abort();

    await expect(promise).resolves.toEqual({ ok: false, code: "cancelled" });
    expect(child.killed).toBe(true);
  });

  it("does not spawn at all for an already-cancelled run", async () => {
    const spawn = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const result = await callCli({
      ...base,
      signal: controller.signal,
      spawn: spawn as unknown as SpawnPort
    });

    expect(result).toEqual({ ok: false, code: "cancelled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not return the tool's diagnostics", async () => {
    // stderr is read so the pipe cannot block the child, and discarded: a
    // tool's diagnostics can echo whatever was on stdin.
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });

    child.warn("warning: your key sk-ant-leaked looks wrong");
    child.print("the answer");
    child.close(0);

    const result = await promise;
    expect(JSON.stringify(result)).not.toContain("sk-ant-leaked");
    expect(JSON.stringify(result)).not.toContain("warning");
  });

  it("settles once, whatever else the process does", async () => {
    const child = new FakeChild();
    const promise = callCli({ ...base, spawn: spawnPort(child) });

    child.print("first");
    child.close(0);
    child.close(1);
    child.fail(new Error("late"));

    await expect(promise).resolves.toEqual({ ok: true, text: "first" });
  });
});
