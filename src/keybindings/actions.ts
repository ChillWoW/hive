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
    }
];
