import { TerminalWindowIcon, type Icon } from "@phosphor-icons/react";
import type { ActionId } from "@/keybindings";
import { openTerminalTab } from "./actions";

/** Something the "+" menu opens in a new tab. */
export type NewTab = {
    label: string;
    icon: Icon;
    /** Its shortcut, shown on the right of its row. */
    shortcut?: ActionId;
    open: () => void;
};

/**
 * What the "+" menu offers, in its order; it's hidden while there's nothing.
 * Files open from the file panel's tree instead.
 */
export const NEW_TABS: readonly NewTab[] = [
    {
        label: "Terminal",
        icon: TerminalWindowIcon,
        shortcut: "newTerminal",
        open: () => openTerminalTab()
    }
];
