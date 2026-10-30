import type { KeyboardSettings } from "@/proto";

export type ActionId = Exclude<keyof KeyboardSettings, "sendWith">;

export type Action = {
    id: ActionId;
    label: string;
    description?: string;
    /** Extra search words for the settings page. */
    keywords: string;
    /** `composer`: only while focus is in the prompt box. */
    scope: "global" | "composer";
    /** Runs again while the keys are held. */
    repeats?: boolean;
};

/** Settings page order. A new one: a field in `KeyboardSettings`, then a row here. */
export const ACTIONS: readonly Action[] = [
    {
        id: "newChat",
        label: "New chat",
        keywords: "create start new chat conversation",
        scope: "global"
    },
    {
        id: "focusComposer",
        label: "Focus prompt",
        keywords: "focus composer input type prompt message box",
        scope: "global"
    },
    {
        id: "previousChat",
        label: "Previous chat",
        description: "The chat above in the sidebar",
        keywords: "previous chat up switch navigate cycle",
        scope: "global",
        repeats: true
    },
    {
        id: "nextChat",
        label: "Next chat",
        description: "The chat below in the sidebar",
        keywords: "next chat down switch navigate cycle",
        scope: "global",
        repeats: true
    },
    {
        id: "goBack",
        label: "Back",
        description: "The chat you were on before",
        keywords: "back previous history navigate return",
        scope: "global",
        repeats: true
    },
    {
        id: "goForward",
        label: "Forward",
        description: "Undoes Back",
        keywords: "forward next history navigate",
        scope: "global",
        repeats: true
    },
    {
        id: "toggleSidebar",
        label: "Toggle sidebar",
        keywords: "sidebar hide show collapse panel",
        scope: "global"
    },
    {
        id: "toggleFilePanel",
        label: "Toggle file panel",
        keywords: "files file panel tree explorer hide show",
        scope: "global"
    },
    {
        id: "searchFiles",
        label: "Search files",
        description: "Opens the file panel's search",
        keywords: "search find files go to file open quick",
        scope: "global"
    },
    {
        id: "toggleRightSidebar",
        label: "Toggle right sidebar",
        keywords: "right sidebar tabs panel hide show collapse",
        scope: "global"
    },
    {
        id: "closeTab",
        label: "Close tab",
        description: "The right sidebar's shown tab",
        keywords: "close tab file terminal right sidebar",
        scope: "global"
    },
    {
        id: "newTerminal",
        label: "New terminal",
        description: "In the right sidebar, in the chat's folder",
        keywords: "terminal shell console command line new open",
        scope: "global"
    },
    {
        id: "openDiff",
        label: "Show diff",
        description: "In the right sidebar, for the chat's folder",
        keywords: "diff changes git review compare open",
        scope: "global"
    },
    {
        id: "openHistory",
        label: "Show history",
        description: "In the right sidebar, for the chat's folder",
        keywords: "history commits log graph branches git open",
        scope: "global"
    },
    {
        id: "openSettings",
        label: "Settings",
        description: "Opens or closes this window",
        keywords: "settings preferences options open close",
        scope: "global"
    },
    {
        id: "openUsage",
        label: "Usage",
        description: "Tokens and cost across your agents",
        keywords: "usage cost tokens spend limits billing open close",
        scope: "global"
    },
    {
        id: "togglePlan",
        label: "Toggle plan mode",
        description: "While typing a prompt",
        keywords: "plan mode toggle switch",
        scope: "composer"
    }
];

export const actionById = (id: ActionId) => ACTIONS.find((a) => a.id === id)!;
