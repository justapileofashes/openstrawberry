export type ShortcutInput = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };
export type BrowserShortcut = "command-palette" | "address-bar" | "new-tab" | "toggle-split" | "none";

export function resolveBrowserShortcut(input: ShortcutInput): BrowserShortcut {
  const primary = input.ctrlKey || input.metaKey;
  if (!primary || input.altKey) return "none";
  const key = input.key.toLowerCase();
  if (key === "k") return "command-palette";
  if (key === "l") return "address-bar";
  if (key === "t" && !input.shiftKey) return "new-tab";
  if (key === "s" && input.shiftKey) return "toggle-split";
  return "none";
}
