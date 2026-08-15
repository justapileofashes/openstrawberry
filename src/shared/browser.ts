export const PANE_IDS = ["primary", "secondary"] as const;
export type BrowserPaneId = (typeof PANE_IDS)[number];
export type BrowserTabState = { id: string; url: string; title: string; favicon: string | null; isLoading: boolean; canGoBack: boolean; canGoForward: boolean; isAudible: boolean };
export type BrowserPaneState = { id: BrowserPaneId; tabId: string | null };
export type BrowserViewport = { paneId: BrowserPaneId; x: number; y: number; width: number; height: number };
export type BrowserDownloadState = { id: string; filename: string; receivedBytes: number; totalBytes: number; state: "progressing" | "completed" | "cancelled" };
export type BrowserSnapshot = { activeTabId: string | null; activePaneId: BrowserPaneId; splitEnabled: boolean; panes: BrowserPaneState[]; tabs: BrowserTabState[]; downloads: BrowserDownloadState[] };
export type BrowserCommand = "back" | "forward" | "reload" | "stop";
