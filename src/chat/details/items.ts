import { type ChatDetailsSettings, DEFAULT_SETTINGS } from "@/proto";
import { useSettingsStore } from "@/settings/store";

export type DetailsItemId = keyof ChatDetailsSettings;

/** The card's rows, in its order, as the menus name them. */
export const DETAILS_ITEMS: readonly { id: DetailsItemId; label: string }[] = [
    { id: "project", label: "Project" },
    { id: "worktree", label: "Worktree" },
    { id: "openIn", label: "Open in editor" },
    { id: "terminal", label: "Open terminal" },
    { id: "changes", label: "Changes" },
    { id: "sync", label: "Sync" },
    { id: "github", label: "Open on GitHub" },
    { id: "cost", label: "Cost" }
];

/** Which rows show (the `chatDetails` settings section). */
export function useDetailsItems(): ChatDetailsSettings {
    return useSettingsStore((s) => s.settings.chatDetails);
}

export const isDefaultDetailsItems = (shown: ChatDetailsSettings) =>
    DETAILS_ITEMS.every(({ id }) => shown[id] === DEFAULT_SETTINGS.chatDetails[id]);

export const setDetailsItem = (id: DetailsItemId, shown: boolean) =>
    void useSettingsStore.getState().update({ chatDetails: { [id]: shown } });

export const resetDetailsItems = () =>
    void useSettingsStore.getState().update({ chatDetails: DEFAULT_SETTINGS.chatDetails });
