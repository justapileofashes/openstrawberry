/**
 * Proof that a stored credential never reaches anywhere it could be read.
 *
 * The other agent tests check behaviour. This one checks a single property, from
 * as many angles as it has: a key goes into the store, and then every artefact
 * the system produces is searched for it. Snapshots, config status, both state
 * files on disk, the error text the router hands back, and the step log of a
 * run.
 *
 * It is deliberately blunt. Each assertion serialises a whole object and looks
 * for the secret anywhere inside, so a field added later that happens to carry a
 * key fails this suite without anyone having to remember to extend it. That is
 * the point: this is the test that has to keep working when the agent runtime
 * grows executors, and it should fail loudly the first time one of them leaks.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentManager, type BrowserPort } from "./agent-manager.js";
import { SecretStore, type CipherPort } from "./secret-store.js";
import { redactErrorForRenderer } from "./ipc-security.js";
import { parseResolveApprovalPayload, parseStartRunPayload } from "../shared/agents.js";
import type { BrowserSnapshot } from "../shared/browser.js";

/**
 * Distinctive enough that a substring search cannot match it by accident, and
 * shaped like the real thing so a partial write would still be caught.
 */
const SECRET = "sk-ant-REDACTION-CANARY-8f3a91d7e5b04c2a";
const OTHER_SECRET = "sk-openai-REDACTION-CANARY-11bb22cc33dd";

/** A reversible stand-in for the OS keychain. Obviously not plaintext. */
function bufferCipher(): CipherPort {
  const shift = 42;
  return {
    availability: () => "available",
    encrypt: (plaintext) =>
      Buffer.from([...Buffer.from(plaintext, "utf8")].map((byte) => byte ^ shift)),
    decrypt: (ciphertext) =>
      Buffer.from([...ciphertext].map((byte) => byte ^ shift)).toString("utf8")
  };
}

const EMPTY_BROWSER: BrowserSnapshot = {
  tabs: [
    {
      id: "tab-1",
      url: "https://example.com/",
      title: "Example",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      isAudible: false,
      paneId: "primary",
      groupId: null
    }
  ],
  panes: [
    { id: "primary", activeTabId: "tab-1" },
    { id: "secondary", activeTabId: null }
  ],
  activePaneId: "primary",
  splitEnabled: false,
  groups: []
};

const browser: BrowserPort = {
  snapshot: () => EMPTY_BROWSER,
  createTab: () => EMPTY_BROWSER,
  closeTab: () => EMPTY_BROWSER,
  navigate: () => EMPTY_BROWSER,
  goBack: () => EMPTY_BROWSER,
  goForward: () => EMPTY_BROWSER,
  reload: () => EMPTY_BROWSER,
  contentsFor: () => null,
  generationFor: () => 0,
  viewportFor: () => ({ width: 1200, height: 800 })
};

let directory = "";
let published: unknown[] = [];

function build(): { manager: AgentManager; secrets: SecretStore } {
  const secrets = new SecretStore({
    credentialPath: join(directory, "agent-credentials.enc"),
    profilePath: join(directory, "agent-profile.json"),
    cipher: bufferCipher()
  });

  const manager = new AgentManager({
    statePath: join(directory, "agents.json"),
    browser,
    secrets,
    publish: (snapshot) => published.push(snapshot)
  });

  return { manager, secrets };
}

/** Every file the agent subsystem has written, as text. */
function filesOnDisk(): string {
  return readdirSync(directory)
    .map((name) => {
      try {
        return readFileSync(join(directory, name), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

/** Asserts a value carries neither canary, whatever shape it is. */
function expectNoSecrets(value: unknown, what: string): void {
  const serialised = typeof value === "string" ? value : JSON.stringify(value);
  expect(serialised ?? "", what).not.toContain(SECRET);
  expect(serialised ?? "", what).not.toContain(OTHER_SECRET);
  // The distinctive middle, in case a future field stores a fragment.
  expect(serialised ?? "", what).not.toContain("REDACTION-CANARY");
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openstrawberry-redaction-"));
  published = [];
});

describe("credential redaction", () => {
  it("keeps the key out of the agent snapshot", () => {
    const { manager, secrets } = build();
    secrets.setCredential("anthropic", SECRET);
    manager.restore();

    expectNoSecrets(manager.snapshot(), "agent snapshot");
  });

  it("keeps the key out of the config status the panel renders", () => {
    const { manager, secrets } = build();
    secrets.setCredential("anthropic", SECRET);

    const config = manager.getConfig();

    expectNoSecrets(config, "config status");
    // The status still reports the provider as configured, so this is not
    // passing by simply losing the fact that a key exists.
    expect(config.providers.find((entry) => entry.id === "anthropic")?.configured).toBe(true);
  });

  it("keeps the key out of every pushed snapshot", () => {
    // The panel renders from pushed state, so a leak here would reach the
    // renderer without any channel being called.
    const { manager, secrets } = build();
    manager.restore();
    secrets.setCredential("anthropic", SECRET);
    manager.setCredential({ provider: "openai", key: OTHER_SECRET, companionId: null });

    expect(published.length).toBeGreaterThan(0);
    for (const snapshot of published) expectNoSecrets(snapshot, "pushed snapshot");
  });

  it("keeps the key out of the state files it writes", () => {
    const { manager, secrets } = build();
    secrets.setCredential("anthropic", SECRET);
    secrets.setOrchestrator("anthropic", "claude-opus-5", null, null);
    manager.restore();
    manager.createCompanion({
      name: "Scout",
      role: "research",
      provider: "anthropic",
      model: null,
      baseUrl: null,
      command: null
    });
    manager.destroy();

    // agents.json and agent-profile.json are plain JSON by design; only the
    // .enc file may hold the key, and only as ciphertext.
    const profile = readFileSync(join(directory, "agent-profile.json"), "utf8");
    const state = readFileSync(join(directory, "agents.json"), "utf8");

    expectNoSecrets(profile, "agent-profile.json");
    expectNoSecrets(state, "agents.json");
  });

  it("stores the key only as ciphertext", () => {
    const { secrets } = build();
    secrets.setCredential("anthropic", SECRET);

    const ciphertext = readFileSync(join(directory, "agent-credentials.enc"), "utf8");

    expect(ciphertext).not.toContain(SECRET);
    // And it really is the key, reachable only through the store's read path.
    expect(secrets.readCredential("anthropic")).toBe(SECRET);
  });

  it("keeps the key out of a run's step log", () => {
    const { manager, secrets } = build();
    secrets.setCredential("anthropic", SECRET);
    manager.restore();

    const companion = manager.snapshot().companions[0];
    expect(companion).toBeDefined();

    manager.startRun({
      companionId: companion?.id ?? "",
      task: "Summarise the open tab",
      tabIds: ["tab-1"]
    });

    // The scripted loop names the provider it would have called; that label must
    // describe the route without carrying what authenticates it.
    expectNoSecrets(manager.snapshot(), "snapshot after a run started");
  });

  it("scrubs a key out of a task the user typed", () => {
    // A user pasting a key into the composer - to ask an agent to use it, or by
    // accident - would otherwise have it written verbatim into agents.json,
    // which is ordinary JSON that nothing encrypts.
    const { manager, secrets } = build();
    secrets.setCredential("anthropic", SECRET);
    manager.restore();

    const companion = manager.snapshot().companions[0];
    const task = parseStartRunPayload({
      companionId: companion?.id ?? "",
      task: `use this key ${SECRET}`,
      tabIds: []
    });

    manager.startRun(task);
    manager.destroy();

    const state = readFileSync(join(directory, "agents.json"), "utf8");

    // The rest of the instruction survives; only the key is gone.
    expect(state).toContain("use this key");
    expectNoSecrets(state, "agents.json after a task containing a key");
    expectNoSecrets(manager.snapshot(), "snapshot after a task containing a key");
  });

  it("keeps the key out of a run that drove the browser", async () => {
    /*
     * The route that reaches a provider with tools attached is the newest way a
     * credential travels, and the one with the most places for it to land: a
     * transcript, a tool argument, a tool result, and a step written for each.
     * The key goes in at the port, as it must, and nothing downstream of that
     * may carry it.
     */
    const secrets = new SecretStore({
      credentialPath: join(directory, "agent-credentials.enc"),
      profilePath: join(directory, "agent-profile.json"),
      cipher: bufferCipher()
    });

    secrets.setCredential("anthropic", SECRET);
    secrets.setOrchestrator("anthropic", "claude-opus-5", null, null);

    let sawCredential = false;
    let step = 0;

    const manager = new AgentManager({
      statePath: join(directory, "agents.json"),
      browser,
      secrets,
      publish: (snapshot) => published.push(snapshot),
      provider: () => Promise.resolve({ ok: false, code: "network" }),
      providerTurn: (request) => {
        // The credential does reach the transport. That is the whole point of
        // the transport, and it is the last place it is allowed to be.
        if (request.credential === SECRET) sawCredential = true;

        step += 1;
        return Promise.resolve(
          step === 1
            ? {
                ok: true,
                reply: {
                  text: "Looking at the tab.",
                  toolCalls: [{ id: "c1", name: "list_tabs", arguments: {} }]
                }
              }
            : { ok: true, reply: { text: "One tab is open.", toolCalls: [] } }
        );
      }
    });

    manager.restore();

    const companion = manager.snapshot().companions[0];
    manager.startRun(
      parseStartRunPayload({
        companionId: companion?.id ?? "",
        task: "what is open",
        tabIds: ["tab-1"]
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 800));
    manager.destroy();

    expect(sawCredential).toBe(true);
    expectNoSecrets(manager.snapshot(), "snapshot after a browser run");
    expectNoSecrets(filesOnDisk(), "files on disk after a browser run");
    for (const snapshot of published) expectNoSecrets(snapshot, "pushed snapshot");
  });

  it("keeps a page's own words off disk, however the tool answered", async () => {
    /*
     * A different canary from the credential ones, for a different rule: the
     * contents of a signed-in page must not outlive the window in plain JSON.
     * Both halves are checked, because a failed tool result and a successful one
     * take different paths into the log - and the `run` tool made the failed one
     * reachable by text a script wrote rather than by wording this app holds.
     */
    const PAGE_CANARY = "PAGE-CONTENT-CANARY-account-balance-4471";

    const secrets = new SecretStore({
      credentialPath: join(directory, "agent-credentials.enc"),
      profilePath: join(directory, "agent-profile.json"),
      cipher: bufferCipher()
    });
    secrets.setOrchestrator("anthropic", "claude-opus-5", null, null);

    let step = 0;
    const manager = new AgentManager({
      statePath: join(directory, "agents.json"),
      browser,
      secrets,
      publish: (snapshot) => published.push(snapshot),
      provider: () => Promise.resolve({ ok: false, code: "network" }),
      providerTurn: () => {
        step += 1;
        return Promise.resolve(
          step === 1
            ? {
                ok: true,
                reply: {
                  text: "Collecting it.",
                  toolCalls: [
                    { id: "c1", name: "run", arguments: { script: "return browser.list_tabs();" } }
                  ]
                }
              }
            : { ok: true, reply: { text: "Done.", toolCalls: [] } }
        );
      },
      scriptRunner: {
        // Stands in for a script that put page text on its failure path, which
        // is the one result body this application does not author itself.
        run: () => Promise.resolve({ text: PAGE_CANARY, isError: true, image: null })
      }
    });

    manager.restore();
    const companion = manager.snapshot().companions[0];
    manager.startRun(
      parseStartRunPayload({
        companionId: companion?.id ?? "",
        task: "read it",
        tabIds: ["tab-1"]
      })
    );

    /*
     * `run` stops for the once-per-run interaction consent, and nothing here is
     * a user. Answering it is what lets the script actually run, which is what
     * makes this test check the path rather than the refusal of it.
     */
    let allowed = false;
    for (let attempt = 0; attempt < 40 && !allowed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const approval = manager.snapshot().runs.at(-1)?.pendingApproval ?? null;
      if (approval === null) continue;
      manager.resolveApproval(
        parseResolveApprovalPayload({ approvalId: approval.id, decision: "allow" })
      );
      allowed = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));

    // The canary did travel: it is in the live log, which is what the panel shows.
    expect(JSON.stringify(manager.snapshot())).toContain(PAGE_CANARY);

    manager.destroy();
    expect(filesOnDisk()).not.toContain(PAGE_CANARY);
  });

  it("keeps the key out of redacted error text", () => {
    // Main-process errors routinely carry whatever was in scope. Only errors
    // this codebase authored pass through; everything else collapses.
    const leaky = new Error(`request failed with Authorization: Bearer ${SECRET}`);

    expectNoSecrets(redactErrorForRenderer(leaky), "redacted error");
    expect(redactErrorForRenderer(leaky)).toBe("The request could not be completed.");
  });

  it("keeps the key out of a refusal to store one", () => {
    const unavailable: CipherPort = {
      availability: () => "unavailable",
      encrypt: () => Buffer.alloc(0),
      decrypt: () => ""
    };

    const secrets = new SecretStore({
      credentialPath: join(directory, "agent-credentials.enc"),
      profilePath: join(directory, "agent-profile.json"),
      cipher: unavailable
    });

    let message = "";
    try {
      secrets.setCredential("anthropic", SECRET);
    } catch (error) {
      message = redactErrorForRenderer(error);
    }

    expect(message.length).toBeGreaterThan(0);
    expectNoSecrets(message, "storage-unavailable message");
  });

  it("keeps one provider's key out of another's status", () => {
    const { manager, secrets } = build();
    secrets.setCredential("anthropic", SECRET);
    secrets.setCredential("openai", OTHER_SECRET);

    expectNoSecrets(manager.getConfig(), "multi-provider config");
    expect(secrets.readCredential("anthropic")).toBe(SECRET);
    expect(secrets.readCredential("openai")).toBe(OTHER_SECRET);
  });

  it("keeps a per-agent key out of everything the renderer sees", () => {
    const { manager, secrets } = build();
    manager.restore();

    const companion = manager.snapshot().companions[0];
    manager.setCredential({
      provider: "anthropic",
      key: SECRET,
      companionId: companion?.id ?? null
    });

    expectNoSecrets(manager.snapshot(), "snapshot with a per-agent key");
    expectNoSecrets(manager.getConfig(), "config with a per-agent key");

    // The status says an agent has its own key without saying what it is.
    const scoped = manager.getConfig().agentCredentials;
    expect(scoped.some((entry) => entry.companionId === companion?.id)).toBe(true);

    void secrets;
  });

  it("leaves nothing behind on disk once a key is cleared", () => {
    const { secrets } = build();
    secrets.setCredential("anthropic", SECRET);
    secrets.clearCredential("anthropic");

    expectNoSecrets(filesOnDisk(), "every file after clearing");
    expect(secrets.readCredential("anthropic")).toBeNull();
  });

  it("leaves nothing behind when an agent that owned a key is deleted", () => {
    const { manager, secrets } = build();
    manager.restore();

    manager.createCompanion({
      name: "Second",
      role: "research",
      provider: "anthropic",
      model: null,
      baseUrl: null,
      command: null
    });

    const created = manager.snapshot().companions.at(-1);
    manager.setCredential({
      provider: "anthropic",
      key: SECRET,
      companionId: created?.id ?? null
    });

    manager.deleteCompanion({ companionId: created?.id ?? "" });
    manager.destroy();

    // The key went with the only thing that could have used it.
    expect(secrets.readCredential("anthropic", created?.id ?? null)).toBeNull();
    expectNoSecrets(filesOnDisk(), "every file after deleting the agent");
  });
});
