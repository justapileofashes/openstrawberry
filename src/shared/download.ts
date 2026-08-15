export function downloadProgress(receivedBytes: number, totalBytes: number): number | null {
  if (!Number.isFinite(receivedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((receivedBytes / totalBytes) * 100)));
}
