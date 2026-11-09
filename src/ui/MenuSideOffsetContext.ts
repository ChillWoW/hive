import { createContext } from "react";

/** Default gap between a menu popup and its anchor. A context menu's root sets `undefined` so Base
 *  UI places it by the cursor with its own context-menu offsets; every submenu sets the gap back,
 *  so submenus inside either kind of menu sit the same distance from their trigger. An explicit
 *  `sideOffset` prop still wins. */
export const MenuSideOffsetContext = createContext<number | undefined>(6);
