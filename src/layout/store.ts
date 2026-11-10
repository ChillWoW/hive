import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** The left sidebar's width in px. */
export const SIDEBAR_WIDTH = 280;

type LayoutState = {
    sidebarOpen: boolean;
    toggleSidebar: () => void;
};

/** Which panels are open; persisted per device. */
export const useLayoutStore = create<LayoutState>()(
    persist(
        (set) => ({
            sidebarOpen: true,
            toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen }))
        }),
        {
            name: "outcode.layout",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ sidebarOpen: s.sidebarOpen })
        }
    )
);
