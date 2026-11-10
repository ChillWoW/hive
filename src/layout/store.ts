import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * A column beside the main one: the sidebar on the left; the right sidebar,
 * then the file panel at the window's edge, on the right.
 */
export type Panel = "left" | "right" | "files";

export const PANELS: readonly Panel[] = ["left", "right", "files"];

/** Which window edge a panel hangs off. */
export const edgeOf = (panel: Panel): "left" | "right" => (panel === "left" ? "left" : "right");

/** Each panel's widths in px. */
export const PANEL_WIDTHS: Record<Panel, { min: number; max: number; default: number }> = {
    left: { min: 220, max: 480, default: 280 },
    right: { min: 360, max: 960, default: 520 },
    files: { min: 220, max: 440, default: 286 }
};

/** A drag never squeezes the main column narrower than this. */
export const MAIN_MIN_WIDTH = 300;

const clampWidth = (panel: Panel, width: number) => {
    const { min, max } = PANEL_WIDTHS[panel];
    return Math.round(Math.min(Math.max(width, min), max));
};

const OPEN_KEY = { left: "sidebarOpen", right: "rightSidebarOpen", files: "filesOpen" } as const;
const WIDTH_KEY = {
    left: "sidebarWidth",
    right: "rightSidebarWidth",
    files: "filesWidth"
} as const;

type LayoutState = {
    sidebarOpen: boolean;
    rightSidebarOpen: boolean;
    filesOpen: boolean;
    /** Widths while open. */
    sidebarWidth: number;
    rightSidebarWidth: number;
    filesWidth: number;
    /** An edge is being dragged: widths follow the pointer, unanimated. */
    resizing: boolean;
    toggle: (panel: Panel) => void;
    /** Clamped to the panel's min and max. */
    setWidth: (panel: Panel, width: number) => void;
    setResizing: (resizing: boolean) => void;
};

/** Which panels are open and how wide; persisted per device. */
export const useLayoutStore = create<LayoutState>()(
    persist(
        (set) => ({
            sidebarOpen: true,
            rightSidebarOpen: false,
            filesOpen: false,
            sidebarWidth: PANEL_WIDTHS.left.default,
            rightSidebarWidth: PANEL_WIDTHS.right.default,
            filesWidth: PANEL_WIDTHS.files.default,
            resizing: false,
            toggle: (panel) => set((s) => ({ [OPEN_KEY[panel]]: !s[OPEN_KEY[panel]] })),
            setWidth: (panel, width) => set({ [WIDTH_KEY[panel]]: clampWidth(panel, width) }),
            setResizing: (resizing) => set({ resizing })
        }),
        {
            name: "outcode.layout",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({
                sidebarOpen: s.sidebarOpen,
                rightSidebarOpen: s.rightSidebarOpen,
                filesOpen: s.filesOpen,
                sidebarWidth: s.sidebarWidth,
                rightSidebarWidth: s.rightSidebarWidth,
                filesWidth: s.filesWidth
            }),
            // A saved width from before the limits changed snaps into them.
            merge: (saved, current) => {
                const merged = { ...current, ...(saved as Partial<LayoutState>) };
                return {
                    ...merged,
                    sidebarWidth: clampWidth("left", merged.sidebarWidth),
                    rightSidebarWidth: clampWidth("right", merged.rightSidebarWidth),
                    filesWidth: clampWidth("files", merged.filesWidth)
                };
            }
        }
    )
);

export const isPanelOpen = (panel: Panel) => useLayoutStore.getState()[OPEN_KEY[panel]];
export const getPanelWidth = (panel: Panel) => useLayoutStore.getState()[WIDTH_KEY[panel]];
/** A panel's shown width right now: 0 while closed. */
export const getShownWidth = (panel: Panel) => (isPanelOpen(panel) ? getPanelWidth(panel) : 0);

export const usePanelOpen = (panel: Panel) => useLayoutStore((s) => s[OPEN_KEY[panel]]);

/** A panel's width while open, even while closed. */
export const usePanelContentWidth = (panel: Panel) => useLayoutStore((s) => s[WIDTH_KEY[panel]]);

/** A panel's shown width: 0 while closed. */
export const usePanelWidth = (panel: Panel) =>
    useLayoutStore((s) => (s[OPEN_KEY[panel]] ? s[WIDTH_KEY[panel]] : 0));
