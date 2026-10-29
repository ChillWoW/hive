import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type FilesPanelState = {
    /** What the file panel's search field holds. */
    query: string;
    /** Lists hidden and git-ignored files too. */
    showAll: boolean;
    setQuery: (query: string) => void;
    toggleShowAll: () => void;
};

export const useFilesPanelStore = create<FilesPanelState>()(
    persist(
        (set) => ({
            query: "",
            showAll: false,
            setQuery: (query) => set({ query }),
            toggleShowAll: () => set((s) => ({ showAll: !s.showAll }))
        }),
        {
            name: "hive.filesPanel",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ showAll: s.showAll })
        }
    )
);
