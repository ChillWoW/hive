import { create } from "zustand";

export const SIDEBAR_WIDTH = 260;

type LayoutState = {
    sidebarOpen: boolean;
    filePanelOpen: boolean;
    rightSidebarOpen: boolean;
    toggleSidebar: () => void;
    toggleFilePanel: () => void;
    toggleRightSidebar: () => void;
};

export const useLayoutStore = create<LayoutState>()((set) => ({
    sidebarOpen: true,
    filePanelOpen: false,
    rightSidebarOpen: false,
    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    toggleFilePanel: () =>
        set((state) => ({ filePanelOpen: !state.filePanelOpen })),
    toggleRightSidebar: () =>
        set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen }))
}));
