import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { useFocusTrap } from "./focus-trap.js";
import {
  GROUP_COLOURS,
  MAX_GROUP_NAME_LENGTH,
  type GroupColour,
  type TabGroup
} from "../shared/tab-groups.js";

/**
 * Editing one group.
 *
 * The name is held locally while it is being typed and committed on blur or
 * Enter, so a rename is one update rather than one per keystroke - each of which
 * would cross IPC and rewrite the session file.
 */
function Row({
  group,
  memberCount,
  onUpdate,
  onRemove
}: {
  readonly group: TabGroup;
  readonly memberCount: number;
  readonly onUpdate: (name: string, colour: GroupColour, collapsed: boolean) => void;
  readonly onRemove: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(group.name);

  const commitName = (): void => {
    const trimmed = name.trim();
    // An empty name would be refused by the validator anyway; snapping back is
    // kinder than showing an error for something the user can see is blank.
    if (trimmed.length === 0) {
      setName(group.name);
      return;
    }
    if (trimmed !== group.name) onUpdate(trimmed, group.colour, group.collapsed);
  };

  return (
    <li className="gr-item">
      <div className="gr-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => onUpdate(group.name, group.colour, !group.collapsed)}
          aria-label={`${group.collapsed ? "Expand" : "Collapse"} ${group.name}`}
        >
          {group.collapsed ? (
            <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
          )}
        </button>

        <input
          className="gr-name"
          type="text"
          value={name}
          maxLength={MAX_GROUP_NAME_LENGTH}
          aria-label={`Name of group ${group.name}`}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") setName(group.name);
          }}
        />

        <span className="gr-count">
          {memberCount} {memberCount === 1 ? "tab" : "tabs"}
        </span>

        <button
          type="button"
          className="icon-btn"
          onClick={onRemove}
          aria-label={`Ungroup ${group.name}`}
        >
          {/* Dissolves the group. Its tabs are released, never closed. */}
          <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>

      {/*
        Swatches are radio-like buttons rather than a colour input: the palette
        is a closed set, and offering a free colour picker would imply a
        capability the contract deliberately does not have.
      */}
      <div className="gr-swatches" role="group" aria-label={`Colour for ${group.name}`}>
        {GROUP_COLOURS.map((colour) => (
          <button
            key={colour}
            type="button"
            data-group-colour={colour}
            className={`gr-swatch${colour === group.colour ? " is-selected" : ""}`}
            aria-label={colour}
            aria-pressed={colour === group.colour}
            onClick={() => onUpdate(group.name, colour, group.collapsed)}
          />
        ))}
      </div>
    </li>
  );
}

/**
 * Tab groups.
 *
 * Renaming, recolouring, collapsing, and dissolving. Creating a group happens
 * from the palette against the tab in front of you, because a group is always
 * born holding one.
 */
export function GroupsPanel({
  groups,
  memberCounts,
  onUpdate,
  onRemove,
  onClose
}: {
  readonly groups: readonly TabGroup[];
  readonly memberCounts: Readonly<Record<string, number>>;
  readonly onUpdate: (
    groupId: string,
    name: string,
    colour: GroupColour,
    collapsed: boolean
  ) => void;
  readonly onRemove: (groupId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const trapRef = useRef<HTMLElement>(null);
  useFocusTrap(trapRef);

  return (
    <aside className="settings glass" role="dialog" ref={trapRef} aria-label="Tab groups">
      <header className="set-head">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>Tab groups</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close tab groups">
          <X size={15} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </header>

      <div className="set-body">
        {groups.length === 0 ? (
          <p className="gr-empty">
            No groups yet. Open the command palette and choose &ldquo;Group this tab&rdquo; to make
            one.
          </p>
        ) : (
          <ul className="gr-list">
            {groups.map((group) => (
              <Row
                key={group.id}
                group={group}
                memberCount={memberCounts[group.id] ?? 0}
                onUpdate={(name, colour, collapsed) =>
                  onUpdate(group.id, name, colour, collapsed)
                }
                onRemove={() => onRemove(group.id)}
              />
            ))}
          </ul>
        )}

        <p className="set-hint">
          Collapsing hides a group&rsquo;s tabs in the rail. It never closes them, and the tab
          you are looking at always stays visible.
        </p>
      </div>
    </aside>
  );
}
