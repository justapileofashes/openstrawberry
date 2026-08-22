/**
 * Where a `run` script executes, and why that place was chosen.
 *
 * Every other tool in this feature refuses to evaluate a string an agent wrote.
 * This one is built to. That is a real widening of the surface and it is worth
 * being plain about: the value is composition - awaiting six pages at once,
 * looping over rows, collecting one field from each of many tabs - and none of
 * that is a new *capability*, because every call the script makes goes back
 * through `runNamedBrowserTool` with the run's own grants and the run's own
 * approvals. What it buys is fewer round trips through a model that had nothing
 * to decide between them.
 *
 * So the question is only where the string runs. Three places were possible and
 * two of them are wrong:
 *
 *   - **Not in a guest page.** That would hand the script the origin of a site
 *     the user is signed in to, along with its cookies, its storage, and its
 *     fetch. It would be the single worst place in the application to put it.
 *
 *   - **Not in `node:vm`.** A `vm` context is an isolation feature, not a
 *     security boundary, and Node's own documentation says so: the constructor
 *     chain of any object crossing into it leads back out to the host realm.
 *     Running an agent's script there would be running it in this process.
 *
 *   - **In a renderer of its own**, which is what this file does. A hidden
 *     window with no Node, contents isolation on, the Chromium sandbox on, at
 *     `about:blank`, in a session that refuses every network request. That is a
 *     separate V8 isolate in a separate OS process with the same sandbox every
 *     web page in this browser already runs behind. Escaping it means escaping
 *     Chromium, at which point the script tool is not the interesting problem.
 *
 * Inside it the script has exactly one thing to call, `__osTool`, put there by
 * `preload/sandbox.cts`. Everything else is bounded from out here: how long it
 * may run, how many calls it may make, how long it may be, and how much it may
 * return.
 */
import { BrowserWindow, ipcMain, session } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { BROWSER_TOOL_NAMES, MAX_SCRIPT_LENGTH } from "../shared/browser-tools.js";
import type { McpToolResult } from "../shared/mcp.js";
import type { ScriptRunnerPort } from "./browser-tools.js";

/** The channel the sandbox preload forwards on. Pinned to the same literal there. */
const SANDBOX_TOOL_CHANNEL = "sandbox:tool";

/** How long a script may run before its window is destroyed under it. */
export const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * How many tool calls one script may make.
 *
 * The point of the tool is doing the same thing to many pages, so this is
 * generous compared with a hand-written turn - and finite, because a loop with
 * a mistake in it is otherwise a loop that raises approval prompts until
 * somebody force-quits the application.
 */
export const MAX_SCRIPT_CALLS = 40;

/** How much a script may return, before it is cut. */
export const MAX_SCRIPT_RESULT_CHARS = 16_000;

/**
 * The wrapper the script body is placed inside.
 *
 * It builds the `browser` object from the tool names this app actually ships, so
 * a name that does not exist is a `TypeError` the script can see rather than a
 * silent undefined. The result is stringified in there, because what crosses
 * back has to be text and doing it on this side would mean serialising an object
 * from a realm this process does not trust.
 *
 * The body is interpolated. A script that closes the wrapper early and continues
 * outside it is not a defect to guard against here: there is nothing outside it
 * in that world except the one function it was given anyway, and the boundary
 * that matters is the process.
 */
function wrapperFor(script: string): string {
  const methods = BROWSER_TOOL_NAMES.map(
    (name) => `${name}: (args) => window.__osTool(${JSON.stringify(name)}, args || {})`
  ).join(",\n    ");

  return `(async () => {
  const browser = {
    ${methods}
  };
  try {
    const value = await (async () => {
${script}
    })();
    return { ok: true, text: value === undefined ? "" : (typeof value === "string" ? value : JSON.stringify(value)) };
  } catch (error) {
    return { ok: false, text: String((error && error.message) || error || "The script failed.") };
  }
})()`;
}

function truncate(text: string): string {
  return text.length > MAX_SCRIPT_RESULT_CHARS
    ? `${text.slice(0, MAX_SCRIPT_RESULT_CHARS)}\n[The script returned more than one result carries.]`
    : text;
}

/**
 * Runs scripts, one window at a time.
 *
 * The window is built per script and destroyed after it, rather than kept warm.
 * A reused renderer would carry whatever the previous script left in its globals
 * into the next one, and two runs sharing that would be two agents sharing a
 * scratch space.
 */
export class ScriptSandbox implements ScriptRunnerPort {
  private readonly pending = new Map<
    number,
    {
      readonly callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
      calls: number;
    }
  >();

  private handlerInstalled = false;
  private destroyed = false;

  public destroy(): void {
    this.destroyed = true;
    this.pending.clear();
    if (this.handlerInstalled) {
      ipcMain.removeHandler(SANDBOX_TOOL_CHANNEL);
      this.handlerInstalled = false;
    }
  }

  public async run(
    script: string,
    callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>
  ): Promise<McpToolResult> {
    if (this.destroyed) {
      return { text: "Scripts are not available.", isError: true, image: null };
    }
    if (script.length > MAX_SCRIPT_LENGTH) {
      return { text: "That script is too long.", isError: true, image: null };
    }

    this.installHandler();

    let window: BrowserWindow;
    try {
      window = this.createWindow();
    } catch {
      return {
        text: "A sandbox for the script could not be opened. Call the tools directly instead.",
        isError: true,
        image: null
      };
    }

    const contentsId = window.webContents.id;
    this.pending.set(contentsId, { callTool, calls: 0 });

    let timer: NodeJS.Timeout | null = null;

    try {
      await window.webContents.loadURL("about:blank");

      const raced = await Promise.race([
        window.webContents.executeJavaScript(wrapperFor(script)),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), SCRIPT_TIMEOUT_MS);
        })
      ]);

      if (raced === "timeout") {
        return {
          text: `The script ran for ${String(SCRIPT_TIMEOUT_MS / 1000)} seconds without finishing and was stopped. Anything it had already done stands.`,
          isError: true,
          image: null
        };
      }

      const outcome = raced as unknown;
      if (typeof outcome !== "object" || outcome === null) {
        return { text: "The script returned nothing readable.", isError: true, image: null };
      }

      const shaped = outcome as { ok?: unknown; text?: unknown };
      const text = typeof shaped.text === "string" ? shaped.text : "";

      return shaped.ok === true
        ? { text: truncate(text.length === 0 ? "The script finished." : text), isError: false, image: null }
        : { text: truncate(`The script failed: ${text}`), isError: true, image: null };
    } catch {
      /*
       * A syntax error in the body, a renderer that died, a window destroyed
       * under a running script. All of them are the script's problem rather than
       * the run's, so all of them come back as a failed tool result.
       */
      return { text: "The script did not complete.", isError: true, image: null };
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.pending.delete(contentsId);
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /**
   * The one channel the sandbox can speak on.
   *
   * Installed lazily so an OpenStrawberry that never runs a script never
   * registers it, and answered only for a `WebContents` this class is currently
   * running a script in - so a renderer that learned the channel name has
   * nothing to reach even if it could invoke on it, which the pinned preload
   * bridge already prevents.
   */
  private installHandler(): void {
    if (this.handlerInstalled) return;
    this.handlerInstalled = true;

    ipcMain.handle(SANDBOX_TOOL_CHANNEL, async (event, name: unknown, args: unknown) => {
      const active = this.pending.get(event.sender.id);
      if (active === undefined) return { text: "That script is no longer running.", isError: true };

      active.calls += 1;
      if (active.calls > MAX_SCRIPT_CALLS) {
        return {
          text: `A script may make at most ${String(MAX_SCRIPT_CALLS)} tool calls, and this one has used them.`,
          isError: true
        };
      }

      /*
       * Straight into the shared entrance. The name and the arguments are
       * whatever the script produced, which is exactly what a model produces,
       * and they are validated in the same place by the same code.
       */
      const result = await active.callTool(
        typeof name === "string" ? name : "",
        readArguments(args)
      );

      // The image is dropped rather than handed to a script: bytes in a JavaScript
      // variable are of no use to it, and a script that collected several would
      // be assembling a payload nobody bounded.
      return { text: result.text, isError: result.isError };
    });
  }

  private createWindow(): BrowserWindow {
    /*
     * A fresh in-memory session per script - no `persist:` prefix, so nothing it
     * touches survives the window - with every request refused. That refusal is
     * what makes "the script cannot reach the network" a fact about the session
     * rather than a claim about what is in scope inside it.
     */
    const partition = `sandbox-${randomBytes(8).toString("hex")}`;
    const isolated = session.fromPartition(partition);
    isolated.webRequest.onBeforeRequest((_details, callback) => {
      callback({ cancel: true });
    });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });

    const window = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      webPreferences: {
        session: isolated,
        preload: join(import.meta.dirname, "../preload/sandbox.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // Nothing is ever drawn, and a script must not be able to open one.
        devTools: false,
        backgroundThrottling: false
      }
    });

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
    });

    return window;
  }
}

/** Whatever the script passed as arguments, as a plain object or nothing. */
function readArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
