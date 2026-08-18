import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CLI_PROGRAMS,
  callCli,
  childEnvironment,
  isAllowedCommand,
  programName,
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
    // A command line is visible to any process listing on the machine.
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

    expect(captured[0]?.args).toEqual([]);
    expect(JSON.stringify(captured[0]?.args)).not.toContain("private");
    expect(child.stdinText).toBe("a private question");
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
