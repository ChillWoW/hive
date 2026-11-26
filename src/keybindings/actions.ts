import type { KeyboardSettings } from "@/features/settings/types";

export type ActionId = keyof KeyboardSettings;

/** Settings page sections, in order. */
export const CATEGORIES = [{ id: "general", title: "General" }] as const;

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
        id: "newTab",
        category: "general",
        label: "New chat tab",
        description: "Opens the new-chat view in a tab",
        keywords: "new tab chat open create",
        scope: "global"
    },
    {
        id: "closeTab",
        category: "general",
        label: "Close tab",
        description: "Closes the shown chat's tab",
        keywords: "close tab chat",
        scope: "global"
    },
    {
        id: "nextTab",
        category: "general",
        label: "Next tab",
        description: "Shows the tab to the right",
        keywords: "next tab switch cycle chat",
        scope: "global"
    },
    {
        id: "previousTab",
        category: "general",
        label: "Previous tab",
        description: "Shows the tab to the left",
        keywords: "previous tab switch cycle chat",
        scope: "global"
    }
];
