import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

// Widths in px, as in zeron (crates/ui/src/settings.rs).
export const SIDEBAR_WIDTH = 260;
export const FILES_PANEL_MIN = 220;
export const FILES_PANEL_MAX = 440;
export const FILES_PANEL_DEFAULT = 286;
export const RIGHT_SIDEBAR_MIN = 360;
export const RIGHT_SIDEBAR_DEFAULT = 520;
/** The conversation never gets narrower than this beside open panels. */
export const CHAT_MIN = 300;

export type Column = "sidebar" | "files" | "right";

type LayoutState = {
    sidebarOpen: boolean;
    filePanelOpen: boolean;
    rightSidebarOpen: boolean;
    /** When each column was last opened; the oldest hides first when the window is too narrow. */
    openedAt: Record<Column, number>;
    /** Preferred widths; what's shown can be less while the window is narrow. */
    filesWidth: number;
    rightWidth: number;
    /** A panel edge is being dragged (widths follow the pointer, unanimated). */
    resizing: boolean;
    toggleSidebar: () => void;
    toggleFilePanel: () => void;
    toggleRightSidebar: () => void;
    setFilesWidth: (width: number) => void;
    setRightWidth: (width: number) => void;
    setResizing: (resizing: boolean) => void;
};

const OPEN_KEY = {
    sidebar: "sidebarOpen",
    files: "filePanelOpen",
    right: "rightSidebarOpen"
} as const;

const MIN_WIDTH: Record<Column, number> = {
    sidebar: SIDEBAR_WIDTH,
    files: FILES_PANEL_MIN,
    right: RIGHT_SIDEBAR_MIN
};

const COLUMNS: Column[] = ["sidebar", "files", "right"];

type FitInput = Pick<LayoutState, (typeof OPEN_KEY)[Column] | "openedAt">;

/**
 * Which open columns the window has room for: while the conversation and the
 * open columns' minimums don't fit, the one opened longest ago hides. A
 * hidden column stays open and comes back when there's room.
 */
export function fitColumns(
    viewport: number,
    state: FitInput
): Record<Column, boolean> {
    const visible = {
        sidebar: state.sidebarOpen,
        files: state.filePanelOpen,
        right: state.rightSidebarOpen
    };
    for (;;) {
        const open = COLUMNS.filter((c) => visible[c]);
        const minimum = open.reduce((sum, c) => sum + MIN_WIDTH[c], CHAT_MIN);
        if (minimum <= viewport || open.length === 0) return visible;
        const oldest = open.reduce((a, b) =>
            state.openedAt[b] < state.openedAt[a] ? b : a
        );
        visible[oldest] = false;
    }
}

export type PanelLayout = {
    visible: Record<Column, boolean>;
    sidebar: number;
    files: number;
    right: number;
    /** How wide a drag may make each panel right now. */
    filesMax: number;
    rightMax: number;
};

/** Each visible column's width: its preference, as far as the conversation's minimum allows. */
export function panelLayout(
    viewport: number,
    state: FitInput & Pick<LayoutState, "filesWidth" | "rightWidth">
): PanelLayout {
    const visible = fitColumns(viewport, state);
    const sidebar = visible.sidebar ? SIDEBAR_WIDTH : 0;
    const available = viewport - sidebar;
    const filesMax = visible.files
        ? Math.max(
              0,
              Math.min(
                  FILES_PANEL_MAX,
                  available -
                      CHAT_MIN -
                      (visible.right ? RIGHT_SIDEBAR_MIN : 0)
              )
          )
        : 0;
    const files = Math.min(state.filesWidth, filesMax);
    const rightMax = visible.right
        ? Math.max(0, available - files - CHAT_MIN)
        : 0;
    const right = Math.min(state.rightWidth, rightMax);
    return { visible, sidebar, files, right, filesMax, rightMax };
}

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

export const useLayoutStore = create<LayoutState>()(
    persist(
        (set, get) => {
            /**
             * Opens or closes a column. One that's open but hidden for room
             * is brought back instead (it becomes the newest).
             */
            const toggle = (column: Column) => {
                const state = get();
                const key = OPEN_KEY[column];
                const hidden =
                    state[key] && !fitColumns(window.innerWidth, state)[column];
                const open = hidden || !state[key];
                set({
                    [key]: open,
                    ...(open && {
                        openedAt: { ...state.openedAt, [column]: Date.now() }
                    })
                });
            };
            return {
                sidebarOpen: true,
                filePanelOpen: false,
                rightSidebarOpen: false,
                openedAt: { sidebar: 0, files: 0, right: 0 },
                filesWidth: FILES_PANEL_DEFAULT,
                rightWidth: RIGHT_SIDEBAR_DEFAULT,
                resizing: false,
                toggleSidebar: () => toggle("sidebar"),
                toggleFilePanel: () => toggle("files"),
                toggleRightSidebar: () => toggle("right"),
                setFilesWidth: (width) =>
                    set({
                        filesWidth: clamp(
                            width,
                            FILES_PANEL_MIN,
                            FILES_PANEL_MAX
                        )
                    }),
                setResizing: (resizing) => set({ resizing }),
                setRightWidth: (width) =>
                    set({ rightWidth: Math.max(width, RIGHT_SIDEBAR_MIN) })
            };
        },
        {
            name: "hive.layout",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({
                filePanelOpen: s.filePanelOpen,
                rightSidebarOpen: s.rightSidebarOpen,
                openedAt: s.openedAt,
                filesWidth: s.filesWidth,
                rightWidth: s.rightWidth
            })
        }
    )
);

const subscribeResize = (onChange: () => void) => {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
};

export const useViewportWidth = () =>
    useSyncExternalStore(subscribeResize, () => window.innerWidth);

/** The columns shown and their widths, for the window's current width. */
export function usePanelLayout(): PanelLayout {
    const viewport = useViewportWidth();
    const state = useLayoutStore(
        useShallow((s) => ({
            sidebarOpen: s.sidebarOpen,
            filePanelOpen: s.filePanelOpen,
            rightSidebarOpen: s.rightSidebarOpen,
            openedAt: s.openedAt,
            filesWidth: s.filesWidth,
            rightWidth: s.rightWidth
        }))
    );
    return useMemo(() => panelLayout(viewport, state), [viewport, state]);
}
