// Stand-in for Hive's keybinding runtime: the kit only needs a ref's current combo.
const DEFAULTS: Record<string, string> = {
  newChat: "Mod+N",
  openSettings: "Mod+,",
  commandPalette: "Mod+K",
  toggleSidebar: "Mod+B",
};

export type ShortcutRef = string;

export function useBinding(ref: ShortcutRef): string {
  return DEFAULTS[ref] ?? ref;
}
