import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

// Widths in px.
export const SIDEBAR_WIDTH = 260;
const FILES_PANEL_MIN = 220;
const FILES_PANEL_MAX = 440;
const FILES_PANEL_DEFAULT = 286;
const RIGHT_SIDEBAR_MIN = 360;
const RIGHT_SIDEBAR_DEFAULT = 520;
/** The conversation never gets narrower than this beside open panels. */
const CHAT_MIN = 300;
/** Panels shrink before the conversation gets narrower than this. */
const CHAT_COMFORT = 560;

type Column = "sidebar" | "files" | "right";

type LayoutState = {
    sidebarOpen: boolean;
    filePanelOpen: boolean;
    rightSidebarOpen: boolean;
    /** The right sidebar takes the conversation's room too (the left sidebar stays). */
    rightMaximized: boolean;
    /** When each column was last opened; the oldest hides first when the window is too narrow. */
    openedAt: Record<Column, number>;
    /** Preferred widths; what's shown can be less while the window is narrow. */
    filesWidth: number;
    rightWidth: number;
    /** A panel edge is being dragged (widths follow the pointer, unanimated). */
    resizing: boolean;
    /**
     * Opens or closes a column. One that's open but hidden for room is brought
     * back instead (it becomes the newest).
     */
    toggle: (column: Column) => void;
    /** Maximizes the right sidebar (opening it), or restores it. */
    toggleRightMaximized: () => void;
    /** Opens a column, or brings it back when it was hidden for room. */
    show: (column: Column) => void;
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

type FitInput = Pick<
    LayoutState,
    (typeof OPEN_KEY)[Column] | "openedAt" | "rightMaximized"
>;

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
        // A maximized right sidebar leaves the conversation no room.
        const chat = state.rightMaximized && visible.right ? 0 : CHAT_MIN;
        const minimum = open.reduce((sum, c) => sum + MIN_WIDTH[c], chat);
        if (minimum <= viewport || open.length === 0) return visible;
        const oldest = open.reduce((a, b) =>
            state.openedAt[b] < state.openedAt[a] ? b : a
        );
        visible[oldest] = false;
    }
}

type PanelLayout = {
    visible: Record<Column, boolean>;
    sidebar: number;
    files: number;
    right: number;
    /** How wide a drag may make each panel right now. */
    filesMax: number;
    rightMax: number;
    /** The right sidebar is shown and fills the conversation's room. */
    maximized: boolean;
};

/** Each visible column's width: its preference, as far as the conversation's minimum allows. */
function panelLayout(
    viewport: number,
    state: FitInput & Pick<LayoutState, "filesWidth" | "rightWidth">
): PanelLayout {
    const visible = fitColumns(viewport, state);
    const maximized = state.rightMaximized && visible.right;
    const sidebar = visible.sidebar ? SIDEBAR_WIDTH : 0;
    const available = viewport - sidebar;
    // The panels give way down to their minimums before the conversation goes
    // under its comfortable width; past that it shrinks to its minimum.
    const panelMinimums =
        (visible.files ? FILES_PANEL_MIN : 0) +
        (visible.right ? RIGHT_SIDEBAR_MIN : 0);
    const chat = maximized
        ? 0
        : clamp(available - panelMinimums, CHAT_MIN, CHAT_COMFORT);
    const filesMax = visible.files
        ? Math.max(
              0,
              Math.min(
                  FILES_PANEL_MAX,
                  available -
                      chat -
                      (visible.right ? RIGHT_SIDEBAR_MIN : 0)
              )
          )
        : 0;
    const files = Math.min(state.filesWidth, filesMax);
    const rightMax = visible.right
        ? Math.max(0, available - files - chat)
        : 0;
    const right = maximized ? rightMax : Math.min(state.rightWidth, rightMax);
    return { visible, sidebar, files, right, filesMax, rightMax, maximized };
}

const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), max);

export const useLayoutStore = create<LayoutState>()(
    persist(
        (set, get) => {
            /** Open and shown: not hidden for room. */
            const shown = (column: Column) => {
                const state = get();
                return state[OPEN_KEY[column]] && fitColumns(window.innerWidth, state)[column];
            };
            const toggle = (column: Column) => {
                const state = get();
                const key = OPEN_KEY[column];
                const open = !shown(column);
                set({
                    [key]: open,
                    ...(column === "right" && !open && { rightMaximized: false }),
                    ...(open && {
                        openedAt: { ...state.openedAt, [column]: Date.now() }
                    })
                });
            };
            return {
                sidebarOpen: true,
                filePanelOpen: false,
                rightSidebarOpen: false,
                rightMaximized: false,
                openedAt: { sidebar: 0, files: 0, right: 0 },
                filesWidth: FILES_PANEL_DEFAULT,
                rightWidth: RIGHT_SIDEBAR_DEFAULT,
                resizing: false,
                toggle,
                toggleRightMaximized: () => {
                    const state = get();
                    const maximized = state.rightMaximized && shown("right");
                    set({
                        rightMaximized: !maximized,
                        ...(!maximized && {
                            rightSidebarOpen: true,
                            // The newest, so it's the last to hide for room.
                            openedAt: { ...state.openedAt, right: Date.now() }
                        })
                    });
                },
                show: (column) => {
                    if (!shown(column)) toggle(column);
                },
                setFilesWidth: (width) =>
                    set({ filesWidth: clamp(width, FILES_PANEL_MIN, FILES_PANEL_MAX) }),
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
                rightMaximized: s.rightMaximized,
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

const useViewportWidth = () =>
    useSyncExternalStore(subscribeResize, () => window.innerWidth);

/** The columns shown and their widths, for the window's current width. */
export function usePanelLayout(): PanelLayout {
    const viewport = useViewportWidth();
    const state = useLayoutStore(
        useShallow((s) => ({
            sidebarOpen: s.sidebarOpen,
            filePanelOpen: s.filePanelOpen,
            rightSidebarOpen: s.rightSidebarOpen,
            rightMaximized: s.rightMaximized,
            openedAt: s.openedAt,
            filesWidth: s.filesWidth,
            rightWidth: s.rightWidth
        }))
    );
    return useMemo(() => panelLayout(viewport, state), [viewport, state]);
}
