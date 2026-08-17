import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Columns2,
  Download,
  Globe,
  Plus,
  RotateCw,
  Settings2,
  Square,
  X
} from "lucide-react";
import type { BrowserPaneId, BrowserSnapshot } from "../shared/browser.js";
import { BLANK_PAGE } from "../shared/desktop-shell.js";
import type { AppearanceSettings } from "../shared/settings.js";
import { AmbientField } from "./AmbientField.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { applyAppearance, loadAppearance, saveAppearance } from "./settings-store.js";
import {
  activeTabId,
  faviconFallbackLabel,
  focusedTab,
  sameViewport,
  tabAccessibleName,
  viewportFromRect,
  visiblePanes
} from "./browser-chrome.js";

const EMPTY_SNAPSHOT: BrowserSnapshot = {
  tabs: [],
  panes: [
    { id: "primary", activeTabId: null },
    { id: "secondary", activeTabId: null }
  ],
  activePaneId: "primary",
  splitEnabled: false
};

/** Icon-only control with a hover and keyboard-focus text bubble. */
function IconButton({
  label,
  onClick,
  disabled = false,
  children
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="bubble-host">
      <button type="button" className="icon-btn" onClick={onClick} disabled={disabled} aria-label={label}>
        {children}
      </button>
      <span className="bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}

/**
 * A pane is an empty measured region. The real page is a native view the main
 * process composites into these exact bounds, so nothing may be drawn here.
 */
function Pane({
  paneId,
  isActive,
  onBounds,
  onFocus,
  onDropTab
}: {
  readonly paneId: BrowserPaneId;
  readonly isActive: boolean;
  readonly onBounds: (paneId: BrowserPaneId, rect: DOMRect) => void;
  readonly onFocus: (paneId: BrowserPaneId) => void;
  readonly onDropTab: (tabId: string, paneId: BrowserPaneId) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const report = (): void => onBounds(paneId, element.getBoundingClientRect());
    report();

    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [paneId, onBounds]);

  return (
    <div
      ref={ref}
      className={`pane${isActive ? " is-active" : ""}${isDropTarget ? " is-drop-target" : ""}`}
      onMouseDown={() => onFocus(paneId)}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDropTarget(true);
      }}
      onDragLeave={() => setIsDropTarget(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDropTarget(false);
        const tabId = event.dataTransfer.getData("text/plain");
        if (tabId.length > 0) onDropTab(tabId, paneId);
      }}
      data-pane={paneId}
    />
  );
}

export function App(): React.JSX.Element {
  const bridge = window.openstrawberry.browser;
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>(EMPTY_SNAPSHOT);
  const [address, setAddress] = useState("");
  const [addressEdited, setAddressEdited] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);

  // Appearance drives CSS custom properties rather than component state, so the
  // whole chrome responds without re-rendering on every slider tick.
  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);
  const lastViewports = useRef(new Map<BrowserPaneId, ReturnType<typeof viewportFromRect>>());

  useEffect(() => {
    const unsubscribe = bridge.onState(setSnapshot);
    void bridge.getSnapshot().then(setSnapshot);
    return unsubscribe;
  }, [bridge]);

  const current = useMemo(() => focusedTab(snapshot), [snapshot]);

  // The address bar follows the focused tab unless the user is mid-edit.
  useEffect(() => {
    if (addressEdited) return;
    setAddress(current === null || current.url === BLANK_PAGE ? "" : current.url);
  }, [current, addressEdited]);

  const handleBounds = useCallback(
    (paneId: BrowserPaneId, rect: DOMRect) => {
      const viewport = viewportFromRect(rect);
      const previous = lastViewports.current.get(paneId);
      // Resize fires continuously while dragging; only real changes cross IPC.
      if (previous !== undefined && sameViewport(previous, viewport)) return;
      lastViewports.current.set(paneId, viewport);
      void bridge.setViewport(paneId, viewport);
    },
    [bridge]
  );

  const submitAddress = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      if (current === null || address.trim().length === 0) return;
      void bridge.navigate(current.id, address);
      setAddressEdited(false);
    },
    [bridge, current, address]
  );

  const panes = visiblePanes(snapshot);

  return (
    <div className="shell">
      <AmbientField />

      <nav className="tab-rail glass" aria-label="Tabs">
        <div className="rail-tabs">
          {snapshot.tabs.map((tab) => {
            const isActive = activeTabId(snapshot, tab.paneId) === tab.id;
            const name = tabAccessibleName(tab);
            return (
              <span className="bubble-host rail-slot" key={tab.id}>
                <button
                  type="button"
                  className={`rail-tab${isActive ? " is-active" : ""}${tab.isLoading ? " is-loading" : ""}`}
                  onClick={() => void bridge.activateTab(tab.id)}
                  aria-label={name}
                  aria-current={isActive}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", tab.id);
                    setDraggingTabId(tab.id);
                  }}
                  onDragEnd={() => setDraggingTabId(null)}
                >
                  <span className="rail-mark" aria-hidden="true">
                    {tab.faviconUrl === null ? (
                      tab.url === BLANK_PAGE ? (
                        <Globe size={15} strokeWidth={1.5} />
                      ) : (
                        <span className="rail-letter">{faviconFallbackLabel(tab)}</span>
                      )
                    ) : (
                      <img src={tab.faviconUrl} alt="" width={16} height={16} />
                    )}
                  </span>
                  {tab.isAudible && <span className="rail-audio" aria-hidden="true" />}
                </button>

                {/*
                  The close control sits above the mark and shares its centre, so
                  the icon appears to melt into an x on hover. It is a sibling
                  rather than a child because nesting a button inside a button is
                  invalid, and it keeps its own accessible name.
                */}
                <button
                  type="button"
                  className="rail-close"
                  aria-label={`Close ${name}`}
                  onClick={() => void bridge.closeTab(tab.id)}
                >
                  <svg viewBox="0 0 24 24" width="9" height="9" aria-hidden="true">
                    <path
                      d="M7 7 L17 17 M17 7 L7 17"
                      stroke="currentColor"
                      strokeWidth="3.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>

                <span className="bubble" role="tooltip">
                  {name}
                </span>
              </span>
            );
          })}
        </div>

        <div className="rail-foot">
          <IconButton label="New tab" onClick={() => void bridge.createTab(snapshot.activePaneId)}>
            <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
          </IconButton>
        </div>
      </nav>

      <div className="workspace">
        <header className="top-bar glass">
          <div className="nav-cluster">
            <IconButton
              label="Back"
              onClick={() => current !== null && void bridge.back(current.id)}
              disabled={current === null || !current.canGoBack}
            >
              <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton
              label="Forward"
              onClick={() => current !== null && void bridge.forward(current.id)}
              disabled={current === null || !current.canGoForward}
            >
              <ArrowRight size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            {current?.isLoading === true ? (
              <IconButton label="Stop" onClick={() => void bridge.stop(current.id)}>
                <Square size={14} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            ) : (
              <IconButton
                label="Reload"
                onClick={() => current !== null && void bridge.reload(current.id)}
                disabled={current === null}
              >
                <RotateCw size={15} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            )}
          </div>

          <form className="address" onSubmit={submitAddress}>
            <input
              type="text"
              className="address-field"
              value={address}
              placeholder="Search or enter address"
              spellCheck={false}
              aria-label="Address"
              onChange={(event) => {
                setAddress(event.target.value);
                setAddressEdited(true);
              }}
              onBlur={() => setAddressEdited(false)}
            />
          </form>

          <div className="tool-cluster">
            <IconButton
              label={snapshot.splitEnabled ? "Close split" : "Split workspace"}
              onClick={() => void bridge.setSplitEnabled(!snapshot.splitEnabled)}
            >
              <Columns2 size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton label="Downloads" onClick={() => undefined} disabled>
              <Download size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton label="Agents" onClick={() => undefined} disabled>
              <Bot size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={settingsOpen ? "Close settings" : "Settings"}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          </div>
        </header>

        <div className={`panes${snapshot.splitEnabled ? " is-split" : ""}`}>
          {panes.map((paneId) => (
            <div className="pane-slot" key={paneId}>
              {snapshot.splitEnabled && (
                <div className="pane-head">
                  <span className="pane-label">{paneId}</span>
                  <IconButton
                    label={`Close ${paneId} pane`}
                    onClick={() => void bridge.setSplitEnabled(false)}
                  >
                    <X size={13} strokeWidth={1.5} aria-hidden="true" />
                  </IconButton>
                </div>
              )}
              <Pane
                paneId={paneId}
                isActive={snapshot.activePaneId === paneId}
                onBounds={handleBounds}
                onFocus={(next) => void bridge.setActivePane(next)}
                onDropTab={(tabId, target) => void bridge.moveTab(tabId, target)}
              />
            </div>
          ))}

          {/*
            With split off there is no second pane to aim at, so dragging a tab
            reveals an explicit edge target that creates the split on drop.
          */}
          {!snapshot.splitEnabled && draggingTabId !== null && (
            <div
              className="split-target"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const tabId = event.dataTransfer.getData("text/plain");
                setDraggingTabId(null);
                if (tabId.length > 0) void bridge.moveTab(tabId, "secondary");
              }}
            >
              <span className="split-target-label">Drop to split</span>
            </div>
          )}

          {settingsOpen && (
            <SettingsPanel
              settings={appearance}
              onChange={setAppearance}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
