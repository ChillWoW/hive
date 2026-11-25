import { createContext } from "react";

/**
 * Which kind of menu a `Menu.Content` belongs to, so it can pick positioning defaults.
 * Shared by `Menu` and `ContextMenu`; internal, not re-exported from `./ui`.
 */
export type MenuKind = "dropdown" | "context" | "submenu";

export const MenuKindContext = createContext<MenuKind>("dropdown");
