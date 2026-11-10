import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** The left sidebar's widths in px. */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 280;

const clampWidth = (width: number) =>
    Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));

type LayoutState = {
    sidebarOpen: boolean;
    /** Its width while open. */
    sidebarWidth: number;
    /** Its edge is being dragged: widths follow the pointer, unanimated. */
    resizing: boolean;
    toggleSidebar: () => void;
    /** Clamped to the min and max. */
    setSidebarWidth: (width: number) => void;
    setResizing: (resizing: boolean) => void;
};

/** Which panels are open and how wide; persisted per device. */
export const useLayoutStore = create<LayoutState>()(
    persist(
        (set) => ({
            sidebarOpen: true,
            sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
            resizing: false,
            toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
            setSidebarWidth: (width) => set({ sidebarWidth: clampWidth(width) }),
            setResizing: (resizing) => set({ resizing })
        }),
        {
            name: "outcode.layout",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ sidebarOpen: s.sidebarOpen, sidebarWidth: s.sidebarWidth }),
            // A saved width from before the limits changed snaps into them.
            merge: (saved, current) => {
                const merged = { ...current, ...(saved as Partial<LayoutState>) };
                return { ...merged, sidebarWidth: clampWidth(merged.sidebarWidth) };
            }
        }
    )
);

/** The sidebar's shown width: 0 while closed. */
export const useSidebarWidth = () =>
    useLayoutStore((s) => (s.sidebarOpen ? s.sidebarWidth : 0));
