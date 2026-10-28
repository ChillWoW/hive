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
        id: "openSettings",
        label: "Settings",
        description: "Opens or closes this window",
        keywords: "settings preferences options open close",
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
