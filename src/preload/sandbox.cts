/**
 * The only thing a `run` script can reach.
 *
 * A script an agent wrote runs in a renderer of its own: no Node, no network, no
 * page. This preload is the single hole in that wall, and it is one function
 * wide. It forwards a tool name and an arguments object to the trusted process
 * and returns what came back - which is the same `runNamedBrowserTool` an
 * ordinary tool call reaches, with the same closed set, the same grants, and the
 * same approvals.
 *
 * Note what is not here, for the same reasons as the main bridge: no generic
 * `invoke`, no channel the script chooses, no `require`, no filesystem, no
 * process handle. A sandboxed preload may only require `electron`, so this file
 * is self-contained and the channel name is inlined.
 *
 * The script is free to reach past the wrapper it is given, redefine anything in
 * its own world, and inspect everything it can see. That is deliberate rather
 * than tolerated: the boundary is the renderer process, not the shape of the
 * code around the script, so there is nothing on this side worth protecting from
 * it. Everything it can do, it does through the function below.
 */
import electron = require("electron");

const SANDBOX_TOOL_CHANNEL = "sandbox:tool";

electron.contextBridge.exposeInMainWorld("__osTool", (name: unknown, args: unknown) =>
  electron.ipcRenderer.invoke(SANDBOX_TOOL_CHANNEL, name, args)
);
