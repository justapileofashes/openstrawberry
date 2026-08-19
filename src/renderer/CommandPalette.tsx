import { useEffect, useMemo, useRef, useState } from "react";
import {
  clampSelection,
  filterCommands,
  MAX_QUERY_LENGTH,
  moveSelection,
  shortcutLabel,
  type Command
} from "./command-palette.js";

/**
 * The command palette.
 *
 * Holds only JSX and the small amount of state a text field needs; every
 * decision - what matches, how it ranks, where the selection moves - lives in
 * `command-palette.ts` where it is covered by tests.
 *
 * It runs no commands itself. `onRun` receives an id and the caller maps it to a
 * capability the bridge already exposes, so the palette introduces no new IPC
 * surface: it is a new way to reach existing verbs, not a new set of them.
 */
export function CommandPalette({
  platform,
  onRun,
  onClose
}: {
  readonly platform: string;
  readonly onRun: (commandId: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => filterCommands(query), [query]);

  // The palette opens ready to type. Anything else makes the shortcut a
  // two-step: open, then click.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A selection past the end of a shrinking list would highlight nothing and run
  // nothing on Enter.
  useEffect(() => {
    setSelected((current) => clampSelection(current, results.length));
  }, [results.length]);

  // Keeps the highlighted row in view when moving by keyboard past the fold.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[selected];
    if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = (command: Command | undefined): void => {
    if (command === undefined) return;
    onRun(command.id);
    onClose();
  };

  return (
    // A backdrop that closes on click, so the palette never traps a user who
    // opened it by accident.
    <div className="palette-scrim" onMouseDown={onClose}>
      <div
        className="palette glass"
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        // Stops a click inside from reaching the scrim's close handler.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          value={query}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="Type a command"
          aria-label="Search commands"
          aria-controls="palette-results"
          aria-activedescendant={
            results[selected] === undefined ? undefined : `palette-${results[selected].id}`
          }
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((current) => moveSelection(current, 1, results.length));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((current) => moveSelection(current, -1, results.length));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              run(results[selected]);
            }
          }}
        />

        {results.length === 0 ? (
          <p className="palette-empty">No matching command.</p>
        ) : (
          <ul className="palette-list" id="palette-results" role="listbox" ref={listRef}>
            {results.map((command, index) => (
              <li
                key={command.id}
                id={`palette-${command.id}`}
                role="option"
                aria-selected={index === selected}
                className={`palette-row${index === selected ? " is-selected" : ""}`}
                // Pointer and keyboard drive the same selection, so the
                // highlight never disagrees with what Enter would run.
                onMouseEnter={() => setSelected(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  run(command);
                }}
              >
                <span className="palette-title">{command.title}</span>
                <span className="palette-group">{command.group}</span>
                {command.shortcut !== undefined && (
                  <kbd className="palette-chord">
                    {shortcutLabel(command.shortcut, platform)}
                  </kbd>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
