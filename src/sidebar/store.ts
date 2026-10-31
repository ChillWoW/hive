import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const DRAFTS = "drafts";
export const PINNED = "pinned";
export const ARCHIVED = "archived";
export const projectKey = (path: string) => `project:${path}`;

type SidebarState = {
    /** Sections the user folded or unfolded, by key; the rest use their default. */
    collapsed: Record<string, boolean>;
    /** The chat whose title is being edited in place. */
    renaming: string | null;
    /** The search field's text; filters the list while not blank. */
    query: string;
    toggle: (key: string) => void;
    setRenaming: (chatId: string | null) => void;
    setQuery: (query: string) => void;
};

/** Archived starts folded; everything else starts open. */
export function isCollapsed(collapsed: Record<string, boolean>, key: string) {
    return collapsed[key] ?? key === ARCHIVED;
}

/** Fold state persists per device (localStorage); renaming and search don't. */
export const useSidebarStore = create<SidebarState>()(
    persist(
        (set) => ({
            collapsed: {},
            renaming: null,
            query: "",
            toggle: (key) =>
                set((s) => ({
                    collapsed: { ...s.collapsed, [key]: !isCollapsed(s.collapsed, key) }
                })),
            setRenaming: (chatId) => set({ renaming: chatId }),
            setQuery: (query) => set({ query })
        }),
        {
            name: "hive.sidebar",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ collapsed: s.collapsed })
        }
    )
);
