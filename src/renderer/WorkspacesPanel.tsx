import { useRef, useState } from "react";
import { FolderOpen, Trash2, X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  MAX_WORKSPACE_NAME_LENGTH,
  type WorkspaceSnapshot
} from "../shared/workspaces.js";

/**
 * Saved workspaces.
 *
 * The panel says plainly what a workspace is, because the word suggests more
 * than this stores: addresses, not sessions. A user who expects to be signed
 * back in would otherwise discover the difference at the worst moment.
 */
export function WorkspacesPanel({
  snapshot,
  onSave,
  onOpen,
  onRemove,
  onClose
}: {
  readonly snapshot: WorkspaceSnapshot;
  readonly onSave: (name: string) => void;
  readonly onOpen: (workspaceId: string) => void;
  readonly onRemove: (workspaceId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  const save = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onSave(trimmed);
    setName("");
  };

  return (
    <aside className="settings glass" role="dialog" ref={trapRef} aria-label="Saved workspaces">
      <header className="set-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>Saved workspaces</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close workspaces">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        <form
          className="ws-save"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            className="ws-input"
            type="text"
            value={name}
            maxLength={MAX_WORKSPACE_NAME_LENGTH}
            placeholder="Name this set of tabs"
            aria-label="Workspace name"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="text-btn" disabled={name.trim().length === 0}>
            Save open tabs
          </button>
        </form>

        <p className="set-hint">
          A workspace stores the addresses of your open tabs. It does not store cookies,
          sessions, or sign-ins, so opening one loads the pages rather than restoring who you
          were signed in as.
        </p>

        {snapshot.workspaces.length === 0 ? (
          <p className="ws-empty">Nothing saved yet.</p>
        ) : (
          <ul className="ws-list">
            {/* Newest first, which is the order a saved list is looked at. */}
            {[...snapshot.workspaces].reverse().map((workspace) => (
              <li key={workspace.id} className="ws-item">
                <div className="ws-main">
                  <span className="ws-name" title={workspace.name}>
                    {workspace.name}
                  </span>
                  <span className="ws-meta">
                    {workspace.tabs.length} {workspace.tabs.length === 1 ? "tab" : "tabs"}
                  </span>
                </div>
                <div className="ws-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onOpen(workspace.id)}
                    aria-label={`Open ${workspace.name}`}
                  >
                    <FolderOpen size={14} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onRemove(workspace.id)}
                    aria-label={`Delete ${workspace.name}`}
                  >
                    <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
