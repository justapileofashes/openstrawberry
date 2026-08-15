export const PANE_IDS = ["primary", "secondary"] as const;
export type BrowserPaneId = (typeof PANE_IDS)[number];
export const TAB_GROUP_COLORS = ["slate", "blue", "violet", "rose", "amber", "emerald"] as const;
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];
export type BrowserTabState = { id: string; url: string; title: string; favicon: string | null; isLoading: boolean; canGoBack: boolean; canGoForward: boolean; isAudible: boolean; groupId?: string };
export type BrowserTabGroup = { id: string; name: string; color: TabGroupColor; collapsed: boolean; tabIds: string[] };
export type BrowserPaneState = { id: BrowserPaneId; tabId: string | null };
export type BrowserViewport = { paneId: BrowserPaneId; x: number; y: number; width: number; height: number };
export type BrowserDownloadState = { id: string; filename: string; receivedBytes: number; totalBytes: number; state: "progressing" | "completed" | "cancelled" };
export type BrowserSnapshot = { activeTabId: string | null; activePaneId: BrowserPaneId; splitEnabled: boolean; panes: BrowserPaneState[]; tabs: BrowserTabState[]; groups: BrowserTabGroup[]; downloads: BrowserDownloadState[] };
export type BrowserCommand = "back" | "forward" | "reload" | "stop";
export type WorkspaceSnapshot = { id: string; name: string; createdAt: number; tabs: { id: string; url: string; groupId?: string }[]; groups: BrowserTabGroup[]; panes: BrowserPaneState[]; activePaneId: BrowserPaneId; splitEnabled: boolean };

export function validateWorkspaceName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("A workspace name is required.");
  if (normalized.length > 80) throw new Error("Workspace names must be 80 characters or fewer.");
  return normalized;
}

export function validateTabGroupName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("A tab group name is required.");
  if (normalized.length > 40) throw new Error("Tab group names must be 40 characters or fewer.");
  return normalized;
}

export function isTabGroupColor(value: unknown): value is TabGroupColor { return typeof value === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(value); }
