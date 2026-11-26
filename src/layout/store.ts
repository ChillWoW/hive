import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";

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

/** The dock's width: a fixed strip at the window's left edge, outside the panels' room. */
export const DOCK_WIDTH = 48;

/** The gap between the inset box and the window's right and bottom edges. */
export const BOX_INSET = 4;

/** The width the panels and main column share: the window's, less the dock and the box's frame. */
const roomWidth = () => window.innerWidth - DOCK_WIDTH - BOX_INSET - 2;

/** The main column never gets narrower than this beside shown panels. */
export const MAIN_MIN_WIDTH = 300;
/** Panels shrink toward their minimums before the main column gets narrower than this. */
export const MAIN_COMFORT_WIDTH = 560;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const clampWidth = (panel: Panel, width: number) => {
    const { min, max } = PANEL_WIDTHS[panel];
    return Math.round(clamp(width, min, max));
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
    /** Preferred widths; what's shown can be less while the window is narrow. */
    sidebarWidth: number;
    rightSidebarWidth: number;
    filesWidth: number;
    /**
     * When each panel was last opened or resized. Short of room, the least
     * recently used gives up width first, then hides.
     */
    usedAt: Record<Panel, number>;
    /** An edge is being dragged: widths follow the pointer, unanimated. */
    resizing: boolean;
    /** Opens or closes a panel; one open but hidden for room is brought back instead. */
    toggle: (panel: Panel) => void;
    /** Clamped to the panel's min and max. */
    setWidth: (panel: Panel, width: number) => void;
    /** Marks a panel the most recently used, so it's the last to give way. */
    touch: (panel: Panel) => void;
    setResizing: (resizing: boolean) => void;
};

type FitInput = Pick<LayoutState, (typeof OPEN_KEY)[Panel] | (typeof WIDTH_KEY)[Panel] | "usedAt">;

/** Open panels, least recently used first. */
const byUse = (panels: Panel[], state: FitInput) =>
    [...panels].sort((a, b) => state.usedAt[a] - state.usedAt[b]);

/**
 * Which open panels the window has room for: while the main column's and the
 * panels' minimums don't fit, the least recently used hides. A hidden panel
 * stays open and comes back once there's room.
 */
export function fitPanels(viewport: number, state: FitInput): Record<Panel, boolean> {
    const visible = {
        left: state.sidebarOpen,
        right: state.rightSidebarOpen,
        files: state.filesOpen
    };
    for (;;) {
        const open = PANELS.filter((p) => visible[p]);
        const minimum = open.reduce((sum, p) => sum + PANEL_WIDTHS[p].min, MAIN_MIN_WIDTH);
        if (minimum <= viewport || open.length === 0) return visible;
        visible[byUse(open, state)[0]] = false;
    }
}

export type PanelLayout = {
    visible: Record<Panel, boolean>;
    /** Shown widths: 0 while closed or hidden for room. */
    widths: Record<Panel, number>;
    /** How wide a drag may make each panel right now. */
    dragMax: Record<Panel, number>;
};

/**
 * Each shown panel's width: its preference, unless the main column would go
 * under its comfortable width. Then panels give way, least recently used
 * first, down to their minimums; past that the main column shrinks to its own.
 */
export function panelLayout(viewport: number, state: FitInput): PanelLayout {
    const visible = fitPanels(viewport, state);
    const shown = PANELS.filter((p) => visible[p]);
    const minimums = shown.reduce((sum, p) => sum + PANEL_WIDTHS[p].min, 0);
    const main = clamp(viewport - minimums, MAIN_MIN_WIDTH, MAIN_COMFORT_WIDTH);

    const widths: Record<Panel, number> = { left: 0, right: 0, files: 0 };
    for (const p of shown) widths[p] = clampWidth(p, state[WIDTH_KEY[p]]);
    let excess = shown.reduce((sum, p) => sum + widths[p], 0) - (viewport - main);
    for (const p of byUse(shown, state)) {
        if (excess <= 0) break;
        const cut = Math.min(excess, widths[p] - PANEL_WIDTHS[p].min);
        widths[p] -= cut;
        excess -= cut;
    }

    const dragMax: Record<Panel, number> = { left: 0, right: 0, files: 0 };
    for (const p of shown) {
        const others = shown
            .filter((o) => o !== p)
            .reduce((sum, o) => sum + PANEL_WIDTHS[o].min, 0);
        dragMax[p] = Math.max(
            PANEL_WIDTHS[p].min,
            Math.min(PANEL_WIDTHS[p].max, viewport - main - others)
        );
    }
    return { visible, widths, dragMax };
}

/** Which panels are open and how wide; persisted per device. */
export const useLayoutStore = create<LayoutState>()(
    persist(
        (set, get) => ({
            sidebarOpen: true,
            rightSidebarOpen: false,
            filesOpen: false,
            sidebarWidth: PANEL_WIDTHS.left.default,
            rightSidebarWidth: PANEL_WIDTHS.right.default,
            filesWidth: PANEL_WIDTHS.files.default,
            usedAt: { left: 0, right: 0, files: 0 },
            resizing: false,
            toggle: (panel) => {
                const state = get();
                const shown = state[OPEN_KEY[panel]] && fitPanels(roomWidth(), state)[panel];
                set({
                    [OPEN_KEY[panel]]: !shown,
                    ...(!shown && { usedAt: { ...state.usedAt, [panel]: Date.now() } })
                });
            },
            setWidth: (panel, width) => set({ [WIDTH_KEY[panel]]: clampWidth(panel, width) }),
            touch: (panel) => set((s) => ({ usedAt: { ...s.usedAt, [panel]: Date.now() } })),
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
                filesWidth: s.filesWidth,
                usedAt: s.usedAt
            }),
            // A saved width from before the limits changed snaps into them.
            merge: (saved, current) => {
                const merged = { ...current, ...(saved as Partial<LayoutState>) };
                return {
                    ...merged,
                    sidebarWidth: clampWidth("left", merged.sidebarWidth),
                    rightSidebarWidth: clampWidth("right", merged.rightSidebarWidth),
                    filesWidth: clampWidth("files", merged.filesWidth),
                    usedAt: { ...current.usedAt, ...merged.usedAt }
                };
            }
        }
    )
);

export const getPanelWidth = (panel: Panel) => useLayoutStore.getState()[WIDTH_KEY[panel]];

/** The layout for the window's width right now, outside React. */
export const getPanelLayout = () => panelLayout(roomWidth(), useLayoutStore.getState());

const subscribeResize = (onChange: () => void) => {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
};

const useViewportWidth = () => useSyncExternalStore(subscribeResize, roomWidth);

/** The panels shown and their widths, for the window's current width. */
export function usePanelLayout(): PanelLayout {
    const viewport = useViewportWidth();
    const state = useLayoutStore(
        useShallow((s) => ({
            sidebarOpen: s.sidebarOpen,
            rightSidebarOpen: s.rightSidebarOpen,
            filesOpen: s.filesOpen,
            sidebarWidth: s.sidebarWidth,
            rightSidebarWidth: s.rightSidebarWidth,
            filesWidth: s.filesWidth,
            usedAt: s.usedAt
        }))
    );
    return useMemo(() => panelLayout(viewport, state), [viewport, state]);
}

/** A panel is open and has room to show. */
export const usePanelShown = (panel: Panel) => usePanelLayout().visible[panel];

/** A panel's shown width: 0 while closed or hidden for room. */
export const usePanelWidth = (panel: Panel) => usePanelLayout().widths[panel];
