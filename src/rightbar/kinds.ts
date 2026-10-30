import {
    ClockCounterClockwiseIcon,
    GitDiffIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import type { ActionId } from "@/keybindings";
import { openDiffTab, openHistoryTab, openTerminalTab } from "./actions";

/** Something the "+" menu opens in a new tab. */
export type NewTab = {
    label: string;
    /** One line under the label in the empty sidebar. */
    hint: string;
    icon: Icon;
    /** Its shortcut, shown on the right of its row. */
    shortcut?: ActionId;
    open: () => void;
};

/**
 * What the "+" menu offers, in its order; it's hidden while there's nothing.
 * Files open from the file panel's tree instead, commits from the history.
 */
export const NEW_TABS: readonly NewTab[] = [
    {
        label: "Terminal",
        hint: "A shell in the chat's folder",
        icon: TerminalWindowIcon,
        shortcut: "newTerminal",
        open: () => openTerminalTab()
    },
    {
        label: "Diff",
        hint: "What changed in the folder",
        icon: GitDiffIcon,
        shortcut: "openDiff",
        open: () => openDiffTab()
    },
    {
        label: "History",
        hint: "The folder's commits and branches",
        icon: ClockCounterClockwiseIcon,
        open: () => openHistoryTab()
    }
];
