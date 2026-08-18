/**
 * Display logic for the downloads panel.
 *
 * Kept out of the component so the decisions that are easy to get subtly wrong
 * - which actions an item offers, what a size reads as, what a download with no
 * declared length shows - are checkable without rendering anything.
 */
import { isTerminalDownloadState, type DownloadItem } from "../shared/downloads.js";

/**
 * A human-readable size.
 *
 * Binary units, because that is what a file manager on every desktop platform
 * shows, and a browser disagreeing with the folder the file lands in would be
 * its own small confusion.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // One decimal below 10 so "1.4 MB" is distinguishable from "1.9 MB", none
  // above it where the extra digit is noise.
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The progress line under an item.
 *
 * A server that declares no length is common enough to deserve a real answer
 * rather than a stuck bar: the received count alone is honest, where "0%" would
 * not be.
 */
export function describeProgress(item: DownloadItem): string {
  switch (item.state) {
    case "completed":
      return formatBytes(item.receivedBytes);
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Failed";
    case "paused":
    case "progressing": {
      const received = formatBytes(item.receivedBytes);
      if (item.totalBytes <= 0) return item.state === "paused" ? `${received}, paused` : received;

      const total = formatBytes(item.totalBytes);
      const suffix = item.state === "paused" ? ", paused" : "";
      return `${received} of ${total}${suffix}`;
    }
  }
}

/**
 * Completion as a fraction, or null when there is no total to measure against.
 *
 * Null rather than 0 so the component can render an indeterminate bar instead of
 * an empty one that looks stalled.
 */
export function progressFraction(item: DownloadItem): number | null {
  if (isTerminalDownloadState(item.state)) return item.state === "completed" ? 1 : null;
  if (item.totalBytes <= 0) return null;
  return Math.min(1, Math.max(0, item.receivedBytes / item.totalBytes));
}

/** Which controls an item offers. Derived once so the markup cannot disagree. */
export interface DownloadActions {
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canCancel: boolean;
  readonly canReveal: boolean;
}

export function actionsFor(item: DownloadItem): DownloadActions {
  return {
    canPause: item.state === "progressing",
    // Chromium's answer, carried through rather than inferred: a transfer the
    // server will not let us continue must not offer a button that fails.
    canResume: item.state === "paused" && item.canResume,
    canCancel: !isTerminalDownloadState(item.state),
    // Reveal needs a file that exists and a path this process knows, and only a
    // completed download from this run has both.
    canReveal: item.state === "completed"
  };
}

/** Newest first, which is the order a downloads list is read in. */
export function forDisplay(items: readonly DownloadItem[]): readonly DownloadItem[] {
  return [...items].reverse();
}
