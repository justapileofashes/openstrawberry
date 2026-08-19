/**
 * Saved workspaces, on disk.
 *
 * A thin store over `../shared/workspaces.js`, which owns every rule about what
 * a workspace may contain. This class owns only the file and the identifiers.
 *
 * Ids are minted here rather than accepted from the renderer, which is the same
 * assumption `requireIdentifier` encodes everywhere else: every handle the
 * chrome holds is one the trusted process issued.
 */
import { readFileSync } from "node:fs";
import {
  emptyWorkspaceSnapshot,
  MAX_WORKSPACES,
  parseWorkspaces,
  toWorkspaceTabs,
  WORKSPACE_STATE_VERSION,
  type Workspace,
  type WorkspaceSnapshot
} from "../shared/workspaces.js";
import { writeFileAtomically } from "./atomic-write.js";

export interface WorkspaceStoreOptions {
  readonly statePath: string;
  /** Injected so timestamps are checkable. */
  readonly now?: () => number;
}

/** A live tab, as saving one needs it. Addresses and labels; nothing else. */
export interface SavableTab {
  readonly url: string;
  readonly title: string;
}

export class WorkspaceStore {
  private readonly statePath: string;
  private readonly now: () => number;

  private workspaces: readonly Workspace[] = [];
  private nextSequence = 1;

  public constructor(options: WorkspaceStoreOptions) {
    this.statePath = options.statePath;
    this.now = options.now ?? ((): number => Date.now());
    this.restore();
  }

  private restore(): void {
    let raw: unknown = null;
    try {
      const text = readFileSync(this.statePath, "utf8").replace(/^\uFEFF/u, "");
      raw = JSON.parse(text) as unknown;
    } catch {
      raw = null;
    }

    this.workspaces = parseWorkspaces(raw).workspaces;

    // Minting past a restored id keeps handles unique across restarts.
    for (const workspace of this.workspaces) {
      const suffix = Number.parseInt(workspace.id.replace(/^workspace-/u, ""), 10);
      if (Number.isInteger(suffix) && suffix >= this.nextSequence) {
        this.nextSequence = suffix + 1;
      }
    }
  }

  public snapshot(): WorkspaceSnapshot {
    if (this.workspaces.length === 0) return emptyWorkspaceSnapshot();
    return { workspaces: this.workspaces };
  }

  /**
   * Saves the open addresses under a name.
   *
   * A name that is already taken replaces that workspace rather than adding a
   * second with the same label, because two identical rows in a list is not a
   * state anyone wants and "save again" is what a user means by re-using a name.
   *
   * Saving nothing savable is a no-op: a window of blank tabs has nothing to
   * restore, and an empty workspace would sit in the list doing nothing.
   */
  public save(name: string, tabs: readonly SavableTab[]): WorkspaceSnapshot {
    const saved = toWorkspaceTabs(tabs);
    if (saved.length === 0) return this.snapshot();

    const existing = this.workspaces.find(
      (workspace) => workspace.name.toLowerCase() === name.toLowerCase()
    );

    const workspace: Workspace = {
      id: existing?.id ?? `workspace-${this.nextSequence++}`,
      name,
      tabs: saved,
      savedAt: this.now()
    };

    const others = this.workspaces.filter((entry) => entry.id !== workspace.id);
    if (existing === undefined && others.length >= MAX_WORKSPACES) return this.snapshot();

    this.workspaces = [...others, workspace];
    this.persist();
    return this.snapshot();
  }

  public remove(workspaceId: string): WorkspaceSnapshot {
    this.workspaces = this.workspaces.filter((workspace) => workspace.id !== workspaceId);
    this.persist();
    return this.snapshot();
  }

  /** The addresses a workspace holds, for the caller to open. */
  public addressesFor(workspaceId: string): readonly string[] {
    const workspace = this.workspaces.find((entry) => entry.id === workspaceId);
    return workspace?.tabs.map((tab) => tab.url) ?? [];
  }

  private persist(): void {
    try {
      writeFileAtomically(
        this.statePath,
        JSON.stringify({
          version: WORKSPACE_STATE_VERSION,
          workspaces: this.workspaces.slice(-MAX_WORKSPACES)
        })
      );
    } catch {
      // Kept in memory for this session. A failed write costs the save, not the
      // browser, so it is never surfaced as an error the user must act on.
    }
  }
}
