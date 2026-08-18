import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Columns2,
  Download,
  Globe,
  Pause,
  PictureInPicture2,
  Play,
  Plus,
  RotateCw,
  Settings2,
  ShieldCheck,
  Square,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import type { BrowserPaneId, BrowserSnapshot } from "../shared/browser.js";
import { BLANK_PAGE, usesCustomWindowControls } from "../shared/desktop-shell.js";
import { shouldOfferWizard, type MigrationOverview } from "../shared/migration.js";
import { emptyDownloadSnapshot, type DownloadSnapshot } from "../shared/downloads.js";
import { emptyTrackingSnapshot, type TrackingSnapshot } from "../shared/tracking.js";
import { closedReaderState, type ReaderState } from "../shared/reader.js";
import type { AppearanceSettings } from "../shared/settings.js";
import { AgentPanel } from "./AgentPanel.js";
import { AmbientField } from "./AmbientField.js";
import { DownloadsPanel } from "./DownloadsPanel.js";
import { MigrationWizard } from "./MigrationWizard.js";
import { ReaderView } from "./ReaderView.js";
import { CommandPalette } from "./CommandPalette.js";
import { WorkspacesPanel } from "./WorkspacesPanel.js";
import { GroupsPanel } from "./GroupsPanel.js";
import { BookmarksPanel } from "./BookmarksPanel.js";
import { emptyBookmarkPage, type BookmarkPage } from "../shared/bookmarks.js";
import { emptyWorkspaceSnapshot, type WorkspaceSnapshot } from "../shared/workspaces.js";
import { emptyMediaState, type MediaAction, type MediaState } from "../shared/media.js";
import { commandForChord, isPaletteChord } from "./command-palette.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { WindowControls } from "./WindowControls.js";
import { applyAppearance, loadAppearance, saveAppearance } from "./settings-store.js";
import {
  activeTabId,
  faviconFallbackLabel,
  focusedTab,
  groupForTab,
  railTabsForPane,
  sameViewport,
  tabAccessibleName,
  viewportFromRect,
  visiblePanes
} from "./browser-chrome.js";
import { displayHostname as displayName } from "../shared/navigation.js";

const EMPTY_SNAPSHOT: BrowserSnapshot = {
  tabs: [],
  panes: [
    { id: "primary", activeTabId: null },
    { id: "secondary", activeTabId: null }
  ],
  activePaneId: "primary",
  splitEnabled: false,
  groups: []
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
  const [agentOpen, setAgentOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [downloads, setDownloads] = useState<DownloadSnapshot>(emptyDownloadSnapshot);
  const [tracking, setTracking] = useState<TrackingSnapshot>(emptyTrackingSnapshot);
  const [reader, setReader] = useState<ReaderState>(closedReaderState);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkQuery, setBookmarkQuery] = useState("");
  const [bookmarks, setBookmarks] = useState<BookmarkPage>(emptyBookmarkPage);
  const [workspaces, setWorkspaces] = useState<WorkspaceSnapshot>(emptyWorkspaceSnapshot);
  const [media, setMedia] = useState<MediaState>(emptyMediaState);
  const addressRef = useRef<HTMLInputElement>(null);
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);
  const [migration, setMigration] = useState<MigrationOverview | null>(null);
  const [migrationOpen, setMigrationOpen] = useState(false);

  /*
   * The wizard offers itself once, on a launch where migration has neither run
   * nor been dismissed. Reading the overview is also what detects browsers, so a
   * profile that has already migrated never causes another application's
   * directories to be looked at again.
   */
  useEffect(() => {
    void window.openstrawberry.migration
      .getOverview()
      .then((overview) => {
        setMigration(overview);
        setMigrationOpen(shouldOfferWizard(overview.state));
      })
      .catch(() => {
        // Migration being unavailable must never block the browser from opening.
        setMigration(null);
      });
  }, []);

  // Appearance drives CSS custom properties rather than component state, so the
  // whole chrome responds without re-rendering on every slider tick.
  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
  }, [appearance]);
  const lastViewports = useRef(new Map<BrowserPaneId, ReturnType<typeof viewportFromRect>>());
  /** Set while a click is in the middle of focusing the address field. */
  const selectAllOnMouseUp = useRef(false);

  useEffect(() => {
    const unsubscribe = bridge.onState(setSnapshot);
    void bridge.getSnapshot().then(setSnapshot);
    return unsubscribe;
  }, [bridge]);

  /*
   * Downloads are subscribed to whether or not the panel is open, because the
   * trigger carries an active marker: a transfer starting while the panel is
   * closed still has to show up somewhere.
   */
  useEffect(() => {
    const downloadBridge = window.openstrawberry.downloads;
    const unsubscribe = downloadBridge.onState(setDownloads);
    void downloadBridge.getSnapshot().then(setDownloads).catch(() => undefined);
    return unsubscribe;
  }, []);

  /*
   * A download starting opens the panel once, the way a browser reveals its
   * downloads shelf. Keyed on there being active work rather than on a count, so
   * a second download starting while the panel is already open does not reopen
   * something the user just closed.
   */
  useEffect(() => {
    if (downloads.hasActive) setDownloadsOpen(true);
  }, [downloads.hasActive]);

  useEffect(() => {
    const trackingBridge = window.openstrawberry.tracking;
    const unsubscribe = trackingBridge.onState(setTracking);
    void trackingBridge.getSnapshot().then(setTracking).catch(() => undefined);
    return unsubscribe;
  }, []);

  /*
   * The blocker reports on the focused tab, so switching tabs has to re-ask.
   * The count is per page, and the previous tab's number would otherwise sit
   * there describing something the user is no longer looking at.
   */
  useEffect(() => {
    void window.openstrawberry.tracking
      .getSnapshot()
      .then(setTracking)
      .catch(() => undefined);
  }, [snapshot.activePaneId, snapshot.panes]);

  const current = useMemo(() => focusedTab(snapshot), [snapshot]);

  /*
   * Reader mode closes when the page underneath it changes.
   *
   * The extracted text is a snapshot of one page. Leaving it up after a
   * navigation would show an article that is no longer what the tab holds,
   * attributed to a site the user is no longer on.
   */
  useEffect(() => {
    setReader(closedReaderState());
  }, [current?.id, current?.url]);

  /*
   * Media state is polled rather than pushed.
   *
   * There is no main-process event for "this page started playing" - the fact
   * lives in the page's DOM, and reading it means asking. A slow, fixed interval
   * is the honest trade: the control appears a beat late rather than the trusted
   * process running a script in every page continuously.
   *
   * The audible flag from the tab snapshot is what makes that acceptable: a page
   * that is making noise is polled, and a silent one is asked once per
   * navigation and then left alone.
   */
  useEffect(() => {
    const tabId = current?.id;
    if (tabId === undefined || current?.url === BLANK_PAGE) {
      setMedia(emptyMediaState());
      return;
    }

    let cancelled = false;
    const read = (): void => {
      void window.openstrawberry.media
        .getState(tabId)
        .then((next) => {
          if (!cancelled) setMedia(next);
        })
        .catch(() => undefined);
    };

    read();
    const timer = window.setInterval(read, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [current?.id, current?.url]);

  /*
   * The search runs in the trusted process, so this re-asks as the query
   * changes rather than filtering a list held here - the store is far larger
   * than anything that should cross IPC.
   */
  useEffect(() => {
    if (!bookmarksOpen) return;

    let cancelled = false;
    void window.openstrawberry.migration
      .searchBookmarks(bookmarkQuery)
      .then((page) => {
        if (!cancelled) setBookmarks(page);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [bookmarksOpen, bookmarkQuery]);

  const runMedia = useCallback(
    (action: MediaAction): void => {
      const tabId = current?.id;
      if (tabId === undefined) return;
      void window.openstrawberry.media
        .run(tabId, action)
        .then(setMedia)
        .catch(() => undefined);
    },
    [current?.id]
  );

  /**
   * Runs one command by id.
   *
   * Every branch calls a capability the bridge already exposes, which is what
   * keeps the palette from widening the trust boundary: it is a second way to
   * reach existing verbs, not a new set of them.
   */
  const runCommand = useCallback(
    (commandId: string): void => {
      const tabId = current?.id;
      const paneId = snapshot.activePaneId;

      switch (commandId) {
        case "tab.new":
          void bridge.createTab(paneId, BLANK_PAGE);
          return;
        case "tab.close":
          if (tabId !== undefined) void bridge.closeTab(tabId);
          return;
        case "tab.next":
        case "tab.previous": {
          const inPane = snapshot.tabs.filter((tab) => tab.paneId === paneId);
          if (inPane.length < 2 || tabId === undefined) return;
          const index = inPane.findIndex((tab) => tab.id === tabId);
          const delta = commandId === "tab.next" ? 1 : -1;
          const next = inPane[(((index + delta) % inPane.length) + inPane.length) % inPane.length];
          if (next !== undefined) void bridge.activateTab(next.id);
          return;
        }
        case "nav.back":
          if (tabId !== undefined) void bridge.back(tabId);
          return;
        case "nav.forward":
          if (tabId !== undefined) void bridge.forward(tabId);
          return;
        case "nav.reload":
          if (tabId !== undefined) void bridge.reload(tabId);
          return;
        case "nav.stop":
          if (tabId !== undefined) void bridge.stop(tabId);
          return;
        case "nav.address":
          addressRef.current?.focus();
          return;
        case "workspace.split":
          void bridge.setSplitEnabled(!snapshot.splitEnabled);
          return;
        case "group.new": {
          if (tabId === undefined || current === null) return;
          // Named after the site by default. A group that arrives already
          // labelled is one the user can rename rather than one they must.
          void bridge.createGroup(tabId, displayName(current.url)).then(setSnapshot);
          return;
        }
        case "group.manage":
          setGroupsOpen((open) => !open);
          return;
        case "tools.bookmarks":
          setBookmarksOpen((open) => !open);
          return;
        case "group.toggle": {
          const group = current === null ? null : groupForTab(snapshot, current);
          if (group === null) return;
          void bridge
            .updateGroup(group.id, group.name, group.colour, !group.collapsed)
            .then(setSnapshot);
          return;
        }
        case "group.ungroup":
          if (tabId === undefined) return;
          void bridge.assignTabToGroup(tabId, null).then(setSnapshot);
          return;
        case "workspace.snapshots":
          // Re-read on open so the list reflects saves made in another window.
          void window.openstrawberry.workspaces
            .getSnapshot()
            .then(setWorkspaces)
            .catch(() => undefined);
          setWorkspacesOpen((open) => !open);
          return;
        case "tools.downloads":
          setDownloadsOpen((open) => !open);
          return;
        case "tools.reader":
          if (tabId === undefined || current?.url === BLANK_PAGE) return;
          void window.openstrawberry.reader
            .open(tabId)
            .then(setReader)
            .catch(() => setReader({ status: "unavailable", reason: "extraction-failed" }));
          return;
        case "tools.agents":
          setAgentOpen((open) => !open);
          return;
        case "tools.settings":
          setSettingsOpen((open) => !open);
          return;
        case "tools.tracking": {
          if (tabId === undefined || tracking.site.length === 0) return;
          const call = tracking.siteExcepted
            ? window.openstrawberry.tracking.resumeSite(tabId)
            : window.openstrawberry.tracking.exceptSite(tabId);
          void call.then(setTracking);
          return;
        }
        default:
          return;
      }
    },
    [bridge, current, snapshot, tracking]
  );

  /*
   * Global shortcuts.
   *
   * Bound on the window rather than on a container, because a native page view
   * holds focus most of the time and a listener on the chrome's DOM would never
   * see the key. Typing into the address bar is exempt from unmodified handling
   * by construction: every binding here carries a modifier.
   */
  useEffect(() => {
    const platform = window.openstrawberry.shell.platform;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isPaletteChord(event, platform)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }

      // Escape closes whatever is open, in the order a user expects the topmost
      // surface to go first.
      if (event.key === "Escape") {
        if (paletteOpen) setPaletteOpen(false);
        else if (reader.status !== "closed") setReader(closedReaderState());
        return;
      }

      // While the palette is open it owns the keyboard; its own field handles
      // arrows and Enter, and a chord firing underneath would be a surprise.
      if (paletteOpen) return;

      const command = commandForChord(event, platform);
      if (command === null) return;

      event.preventDefault();
      runCommand(command.id);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runCommand, paletteOpen, reader.status]);

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
          {/*
            The rail draws what `railTabsForPane` allows: a collapsed group
            hides its members, except the active tab, which is always shown.
          */}
          {panes
            .flatMap((paneId) => railTabsForPane(snapshot, paneId))
            .map((tab) => {
            const isActive = activeTabId(snapshot, tab.paneId) === tab.id;
            const group = groupForTab(snapshot, tab);
            // The group's name goes into the accessible label, so membership is
            // never carried by colour alone.
            const name =
              group === null
                ? tabAccessibleName(tab)
                : `${tabAccessibleName(tab)}, in group ${group.name}${
                    group.collapsed ? ", collapsed" : ""
                  }`;
            return (
              <span className="bubble-host rail-slot" key={tab.id}>
                <button
                  type="button"
                  data-group-colour={group?.colour}
                  className={`rail-tab${isActive ? " is-active" : ""}${tab.isLoading ? " is-loading" : ""}${
                    group === null ? "" : " is-grouped"
                  }`}
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
              ref={addressRef}
              value={address}
              placeholder="Search or enter address"
              spellCheck={false}
              aria-label="Address"
              onChange={(event) => {
                setAddress(event.target.value);
                setAddressEdited(true);
              }}
              /*
               * Clicking the address selects the whole URL, as every browser
               * does, so typing replaces it. The click that gave focus would
               * otherwise land a caret and collapse that selection, so the
               * mouse-up following a focusing click is suppressed. A click made
               * while the field already had focus still positions the caret
               * normally.
               */
              onFocus={(event) => {
                selectAllOnMouseUp.current = true;
                event.currentTarget.select();
              }}
              onMouseUp={(event) => {
                if (!selectAllOnMouseUp.current) return;
                selectAllOnMouseUp.current = false;
                event.preventDefault();
              }}
              onBlur={() => {
                selectAllOnMouseUp.current = false;
                setAddressEdited(false);
              }}
            />
          </form>

          {/*
            With the system title bar hidden, the top bar is the only surface
            that can move the window. The clusters and the address well are all
            no-drag, so this keeps a strip that is always grabbable — it yields
            width on a narrow window but never disappears.
          */}
          <span className="drag-handle" aria-hidden="true" />

          <div className="tool-cluster">
            {/*
              The shield is the whole interface to tracker blocking: it says how
              many requests were blocked on this page, and clicking it excepts
              the site. The count is text rather than tone alone, and the label
              spells out the state for a screen reader.
            */}
            {tracking.site.length > 0 && (
              <IconButton
                label={
                  tracking.siteExcepted
                    ? `Tracking protection off for ${tracking.site}. Turn it back on`
                    : `${tracking.blockedOnPage} tracker${
                        tracking.blockedOnPage === 1 ? "" : "s"
                      } blocked on ${tracking.site}. Allow trackers on this site`
                }
                onClick={() => {
                  const tabId = current?.id;
                  if (tabId === undefined) return;
                  const call = tracking.siteExcepted
                    ? window.openstrawberry.tracking.resumeSite(tabId)
                    : window.openstrawberry.tracking.exceptSite(tabId);
                  void call.then(setTracking);
                }}
              >
                <span className={`shield${tracking.siteExcepted ? " is-off" : ""}`}>
                  <ShieldCheck size={16} strokeWidth={1.5} aria-hidden="true" />
                  {!tracking.siteExcepted && tracking.blockedOnPage > 0 && (
                    <span className="shield-count" aria-hidden="true">
                      {tracking.blockedOnPage > 99 ? "99+" : tracking.blockedOnPage}
                    </span>
                  )}
                </span>
              </IconButton>
            )}
            {/*
              Media controls appear only when the page actually has media, so
              the cluster does not carry a permanently dead control. Every
              button's action is an identifier from a closed set; none of them
              can express code.
            */}
            {media.hasMedia && (
              <>
                <IconButton
                  label={media.playing ? "Pause media" : "Play media"}
                  onClick={() => runMedia(media.playing ? "pause" : "play")}
                >
                  {media.playing ? (
                    <Pause size={16} strokeWidth={1.5} aria-hidden="true" />
                  ) : (
                    <Play size={16} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </IconButton>
                <IconButton
                  label={media.muted ? "Unmute media" : "Mute media"}
                  onClick={() => runMedia(media.muted ? "unmute" : "mute")}
                >
                  {media.muted ? (
                    <VolumeX size={16} strokeWidth={1.5} aria-hidden="true" />
                  ) : (
                    <Volume2 size={16} strokeWidth={1.5} aria-hidden="true" />
                  )}
                </IconButton>
                {media.canPictureInPicture && (
                  <IconButton
                    label="Picture in picture"
                    onClick={() => runMedia("picture-in-picture")}
                  >
                    <PictureInPicture2 size={16} strokeWidth={1.5} aria-hidden="true" />
                  </IconButton>
                )}
              </>
            )}

            {/*
              Reader mode is offered only for a real page. On about:blank there
              is nothing to lay out, and a control that always reports failure is
              worse than no control.
            */}
            {current !== null && current.url !== BLANK_PAGE && (
              <IconButton
                label={reader.status === "closed" ? "Reader mode" : "Close reader"}
                onClick={() => {
                  if (reader.status !== "closed") {
                    setReader(closedReaderState());
                    return;
                  }
                  void window.openstrawberry.reader
                    .open(current.id)
                    .then(setReader)
                    .catch(() =>
                      setReader({ status: "unavailable", reason: "extraction-failed" })
                    );
                }}
              >
                <BookOpen size={16} strokeWidth={1.5} aria-hidden="true" />
              </IconButton>
            )}
            <IconButton
              label={snapshot.splitEnabled ? "Close split" : "Split workspace"}
              onClick={() => void bridge.setSplitEnabled(!snapshot.splitEnabled)}
            >
              <Columns2 size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={downloadsOpen ? "Close downloads" : "Downloads"}
              onClick={() => setDownloadsOpen((open) => !open)}
            >
              {/*
                The active marker is a class rather than a different glyph, so a
                running transfer is legible without the control changing shape
                under the pointer. Tone alone never carries it: the label above
                is what a screen reader announces.
              */}
              <Download
                size={16}
                strokeWidth={1.5}
                aria-hidden="true"
                className={downloads.hasActive ? "is-active" : undefined}
              />
            </IconButton>
            <IconButton
              label={agentOpen ? "Close agents" : "Agents"}
              onClick={() => setAgentOpen((open) => !open)}
            >
              <Bot size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={settingsOpen ? "Close settings" : "Settings"}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={16} strokeWidth={1.5} aria-hidden="true" />
            </IconButton>
          </div>

          {usesCustomWindowControls(window.openstrawberry.shell.platform) && <WindowControls />}
        </header>

        {/*
          The agent panel is a grid column, not an overlay. Adding the column
          shrinks the pane, and the Pane ResizeObserver below reports the smaller
          rect to the main process so the native view follows.
        */}
        {/*
          `is-migrating` collapses the pane slots to nothing. That is not a
          cosmetic hide: the ResizeObserver in each Pane reports the zero rect to
          the main process, so the native views shrink away and the wizard is not
          drawn behind a live page.
        */}
        <div
          /*
            Reader mode collapses the panes for the same reason migration does:
            a page is a native view the compositor draws above the DOM, so the
            reader could not be seen over it. Collapsing makes the ResizeObserver
            report a zero rect, and the main process shrinks the view away.
          */
          className={`panes${snapshot.splitEnabled ? " is-split" : ""}${
            agentOpen ? " has-agent" : ""
          }${migrationOpen || reader.status !== "closed" ? " is-migrating" : ""}`}
        >
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

          {agentOpen && (
            <AgentPanel browser={snapshot} onClose={() => setAgentOpen(false)} />
          )}

          <ReaderView state={reader} onClose={() => setReader(closedReaderState())} />

          {bookmarksOpen && (
            <BookmarksPanel
              page={bookmarks}
              query={bookmarkQuery}
              onQueryChange={setBookmarkQuery}
              // Opening goes through the ordinary tab path, so a stored address
              // passes exactly the navigation policy a typed one does.
              onOpen={(url) => {
                void bridge.createTab(snapshot.activePaneId, url).then(setSnapshot);
                setBookmarksOpen(false);
              }}
              onClose={() => setBookmarksOpen(false)}
            />
          )}

          {groupsOpen && (
            <GroupsPanel
              groups={snapshot.groups}
              // Counted here rather than stored on the group, so the number can
              // never disagree with what the rail is actually drawing.
              memberCounts={snapshot.tabs.reduce<Record<string, number>>((counts, tab) => {
                if (tab.groupId !== null) counts[tab.groupId] = (counts[tab.groupId] ?? 0) + 1;
                return counts;
              }, {})}
              onUpdate={(groupId, name, colour, collapsed) => {
                void bridge.updateGroup(groupId, name, colour, collapsed).then(setSnapshot);
              }}
              onRemove={(groupId) => void bridge.removeGroup(groupId).then(setSnapshot)}
              onClose={() => setGroupsOpen(false)}
            />
          )}

          {workspacesOpen && (
            <WorkspacesPanel
              snapshot={workspaces}
              onSave={(name) => {
                void window.openstrawberry.workspaces.save(name).then(setWorkspaces);
              }}
              onOpen={(workspaceId) => {
                void window.openstrawberry.workspaces.open(workspaceId).then((next) => {
                  setSnapshot(next);
                  setWorkspacesOpen(false);
                });
              }}
              onRemove={(workspaceId) => {
                void window.openstrawberry.workspaces.remove(workspaceId).then(setWorkspaces);
              }}
              onClose={() => setWorkspacesOpen(false)}
            />
          )}

          {paletteOpen && (
            <CommandPalette
              platform={window.openstrawberry.shell.platform}
              onRun={runCommand}
              onClose={() => setPaletteOpen(false)}
            />
          )}

          {/*
            Every handler sends an id. There is no path on this surface, which is
            what keeps `reveal` a request to show one of the user's own downloads
            rather than a way to open an arbitrary location.
          */}
          {downloadsOpen && (
            <DownloadsPanel
              snapshot={downloads}
              onPause={(id) => void window.openstrawberry.downloads.pause(id).then(setDownloads)}
              onResume={(id) => void window.openstrawberry.downloads.resume(id).then(setDownloads)}
              onCancel={(id) => void window.openstrawberry.downloads.cancel(id).then(setDownloads)}
              onReveal={(id) => void window.openstrawberry.downloads.showInFolder(id).then(setDownloads)}
              onClearFinished={() => {
                void window.openstrawberry.downloads.clearFinished().then(setDownloads);
              }}
              onClose={() => setDownloadsOpen(false)}
            />
          )}

          {settingsOpen && (
            <SettingsPanel
              settings={appearance}
              onChange={setAppearance}
              onClose={() => setSettingsOpen(false)}
              migration={migration}
              onRunMigration={() => {
                void window.openstrawberry.migration.reopen().then((next) => {
                  setMigration(next);
                  setSettingsOpen(false);
                  setMigrationOpen(true);
                });
              }}
              onDeleteStagedPasswords={() => {
                void window.openstrawberry.migration.deleteStagedPasswords().then(setMigration);
              }}
            />
          )}

          {migrationOpen && migration !== null && (
            <MigrationWizard
              overview={migration}
              onOverview={setMigration}
              onClose={() => setMigrationOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
