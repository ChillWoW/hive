import type { KeyboardSettings } from "@/features/settings/types";

export type ActionId = keyof KeyboardSettings;

/** Settings page sections, in order. */
export const CATEGORIES = [
    { id: "general", title: "General" },
    { id: "tabs", title: "Tabs" }
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export type Action = {
    id: ActionId;
    category: CategoryId;
    label: string;
    description?: string;
    /** Extra search words for the settings page. */
    keywords: string;
    /** `composer`: only while focus is in the prompt box. */
    scope: "global" | "composer";
    /** Runs again while the keys are held. */
    repeats?: boolean;
    /** Runs with the settings window open too. */
    always?: boolean;
    /** Off macOS a focused terminal keeps the keys: Ctrl+R searches the shell's history. */
    shellKeeps?: boolean;
};

/** Order within a category on the settings page. A new one: a field in `KeyboardSettings`, then a row here. */
export const ACTIONS: readonly Action[] = [
    {
        id: "openSettings",
        category: "general",
        label: "Settings",
        description: "Opens or closes this window",
        keywords: "settings preferences options open close",
        scope: "global"
    },
    {
        id: "toggleSidebar",
        category: "general",
        label: "Toggle sidebar",
        description: "Shows or hides the project list",
        keywords: "sidebar projects panel left show hide",
        scope: "global"
    },
    {
        id: "toggleRightSidebar",
        category: "general",
        label: "Toggle tabs panel",
        description: "Shows or hides the tabs panel",
        keywords: "right sidebar tabs panel show hide collapse",
        scope: "global"
    },
    {
        id: "toggleFilePanel",
        category: "general",
        label: "Toggle file panel",
        description: "Shows or hides the file tree",
        keywords: "files file panel tree explorer hide show",
        scope: "global"
    },
    {
        id: "searchInFiles",
        category: "general",
        label: "Search in files",
        description: "Searches the folder's files for a text, in the file panel",
        keywords: "search find text grep files folder project contents",
        scope: "global"
    },
    {
        id: "findInChat",
        category: "general",
        label: "Find in chat",
        description: "Searches the open chat's transcript for a text",
        keywords: "find search text chat transcript conversation messages",
        scope: "global",
        // A terminal and a browser tab's page have their own use for it.
        shellKeeps: true
    },
    {
        id: "maximizeTabsPanel",
        category: "general",
        label: "Maximize tabs panel",
        description: "Lets the tabs panel take the chat's room, or gives it back",
        keywords: "maximize fullscreen full screen expand restore tabs panel terminal",
        scope: "global"
    },
    {
        id: "newTerminal",
        category: "general",
        label: "New terminal",
        description: "Opens a terminal in the tabs panel",
        keywords: "terminal shell console new open pty command line",
        scope: "global"
    },
    {
        id: "newBrowserTab",
        category: "general",
        label: "New browser tab",
        description: "Opens a web page in the tabs panel",
        keywords: "browser web page tab url localhost preview site open new",
        scope: "global"
    },
    {
        id: "showChanges",
        category: "general",
        label: "Show changes",
        description: "Shows the folder's uncommitted changes in the tabs panel",
        keywords: "changes diff git uncommitted modified working tree review",
        scope: "global"
    },
    {
        id: "showHistory",
        category: "general",
        label: "Show history",
        description: "Shows the folder's commits and branches in the tabs panel",
        keywords: "history log commits git graph branches tags blame",
        scope: "global"
    },
    {
        id: "goBack",
        category: "general",
        label: "Go back",
        description: "Shows the previously open chat",
        keywords: "back previous history navigate chat",
        scope: "global"
    },
    {
        id: "goForward",
        category: "general",
        label: "Go forward",
        description: "Shows the chat you went back from",
        keywords: "forward next history navigate chat",
        scope: "global"
    },
    {
        id: "refresh",
        category: "general",
        label: "Refresh",
        description: "Reloads the window",
        keywords: "refresh reload restart window page",
        scope: "global",
        always: true,
        shellKeeps: true
    },
    {
        id: "newTab",
        category: "tabs",
        label: "New chat tab",
        description: "Opens the new-chat view in a tab",
        keywords: "new tab chat open create",
        scope: "global"
    },
    {
        id: "closeTab",
        category: "tabs",
        label: "Close tab",
        description: "Closes the shown chat's tab",
        keywords: "close tab chat",
        scope: "global"
    },
    {
        id: "nextTab",
        category: "tabs",
        label: "Next tab",
        description: "Shows the tab to the right",
        keywords: "next tab switch cycle chat",
        scope: "global"
    },
    {
        id: "previousTab",
        category: "tabs",
        label: "Previous tab",
        description: "Shows the tab to the left",
        keywords: "previous tab switch cycle chat",
        scope: "global"
    },
    {
        id: "goToTab1",
        category: "tabs",
        label: "Go to tab 1",
        description: "Shows the first tab",
        keywords: "tab 1 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab2",
        category: "tabs",
        label: "Go to tab 2",
        description: "Shows the second tab",
        keywords: "tab 2 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab3",
        category: "tabs",
        label: "Go to tab 3",
        description: "Shows the third tab",
        keywords: "tab 3 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab4",
        category: "tabs",
        label: "Go to tab 4",
        description: "Shows the fourth tab",
        keywords: "tab 4 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab5",
        category: "tabs",
        label: "Go to tab 5",
        description: "Shows the fifth tab",
        keywords: "tab 5 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab6",
        category: "tabs",
        label: "Go to tab 6",
        description: "Shows the sixth tab",
        keywords: "tab 6 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab7",
        category: "tabs",
        label: "Go to tab 7",
        description: "Shows the seventh tab",
        keywords: "tab 7 switch jump go number",
        scope: "global"
    },
    {
        id: "goToTab8",
        category: "tabs",
        label: "Go to tab 8",
        description: "Shows the eighth tab",
        keywords: "tab 8 switch jump go number",
        scope: "global"
    },
    {
        id: "goToLastTab",
        category: "tabs",
        label: "Go to last tab",
        description: "Shows the rightmost tab",
        keywords: "tab last 9 switch jump go end",
        scope: "global"
    }
];
