import {
    ClockCounterClockwiseIcon,
    GitCommitIcon,
    GitDiffIcon,
    TerminalWindowIcon,
    type Icon
} from "@phosphor-icons/react";
import type { ActionId } from "@/keybindings";
import { openDiffTab, openHistoryTab, openTerminalTab } from "./actions";
import type { TabContent } from "./store";

/** Each kind of tab's icon; a file tab shows its file's. */
export const TAB_ICONS: Record<Exclude<TabContent["kind"], "file">, Icon> = {
    terminal: TerminalWindowIcon,
    diff: GitDiffIcon,
    history: ClockCounterClockwiseIcon,
    commit: GitCommitIcon
};

/** Something the "+" menu opens in a new tab. */
type NewTab = {
    label: string;
    /** One line under the label in the empty sidebar. */
    hint: string;
    icon: Icon;
    /** Its shortcut, shown on the right of its row. */
    shortcut?: ActionId;
    open: () => void;
};

/**
 * What the "+" menu offers, in its order. Files open from the file panel's
 * tree instead, commits from the history.
 */
export const NEW_TABS: readonly NewTab[] = [
    {
        label: "Terminal",
        hint: "A shell in the chat's folder",
        icon: TAB_ICONS.terminal,
        shortcut: "newTerminal",
        open: () => openTerminalTab()
    },
    {
        label: "Diff",
        hint: "What changed in the folder",
        icon: TAB_ICONS.diff,
        shortcut: "openDiff",
        open: () => openDiffTab()
    },
    {
        label: "History",
        hint: "The folder's commits and branches",
        icon: TAB_ICONS.history,
        shortcut: "openHistory",
        open: () => openHistoryTab()
    }
];
