import { create } from "zustand";

export const SIDEBAR_WIDTH = 260;

type LayoutState = {
    sidebarOpen: boolean;
    toggleSidebar: () => void;
};

export const useLayoutStore = create<LayoutState>()((set) => ({
    sidebarOpen: true,
    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen }))
}));
