import { useMemo, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { PANELS, type Panel } from "./placement";

export { PANELS, type Panel };

/** Each panel's widths in px. */
export const PANEL_WIDTHS: Record<Panel, { min: number; max: number; default: number }> = {
    chats: { min: 220, max: 480, default: 280 },
    tabs: { min: 360, max: 960, default: 520 },
    files: { min: 220, max: 440, default: 286 }
};

/** The dock's width: a fixed strip at one window edge, outside the panels' room. */
export const DOCK_WIDTH = 48;

/** The gap between the inset box and the window's edges the dock isn't at. */
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
    return Math.round(clamp(Number.isFinite(width) ? width : PANEL_WIDTHS[panel].default, min, max));
};

/** How long a panel takes to slide open, closed or to a new width; `SidePanel`'s transition. */
export const SLIDE_MS = 200;

const perPanel = <T,>(value: (panel: Panel) => T) =>
    Object.fromEntries(PANELS.map((p) => [p, value(p)])) as Record<Panel, T>;

type LayoutState = {
    open: Record<Panel, boolean>;
    /** Preferred widths; what's shown can be less while the window is narrow. */
    widths: Record<Panel, number>;
    /**
     * When each panel was last opened or resized. Short of room, the least
     * recently used gives up width first, then hides.
     */
    usedAt: Record<Panel, number>;
    /** An edge is being dragged: widths follow the pointer, unanimated. */
    resizing: boolean;
    /** The tabs panel takes the main column's room too; the other panels stay. Not persisted. */
    maximized: boolean;
    /**
     * The tabs panel is sliding to or from maximized: its content follows its
     * edge (terminals fit once it's over), while the main column's keeps its
     * width, to be covered or uncovered rather than reflowed.
     */
    sliding: boolean;
    /** Opens or closes a panel; one open but hidden for room is brought back instead. */
    toggle: (panel: Panel) => void;
    /** Clamped to the panel's min and max. */
    setWidth: (panel: Panel, width: number) => void;
    /** Marks a panel the most recently used, so it's the last to give way. */
    touch: (panel: Panel) => void;
    setResizing: (resizing: boolean) => void;
    /** Maximizes the tabs panel (opening it if need be), or restores it. */
    toggleMaximized: () => void;
};

type FitInput = Pick<LayoutState, "open" | "widths" | "usedAt">;

/** Open panels, least recently used first. */
const byUse = (panels: Panel[], state: FitInput) =>
    [...panels].sort((a, b) => state.usedAt[a] - state.usedAt[b]);

/**
 * Which open panels the window has room for: while the main column's and the
 * panels' minimums don't fit, the least recently used hides. A hidden panel
 * stays open and comes back once there's room.
 */
export function fitPanels(viewport: number, state: FitInput): Record<Panel, boolean> {
    const visible = { ...state.open };
    for (;;) {
        const open = PANELS.filter((p) => visible[p]);
        const minimum = open.reduce((sum, p) => sum + PANEL_WIDTHS[p].min, MAIN_MIN_WIDTH);
        if (minimum <= viewport || open.length === 0) return visible;
        visible[byUse(open, state)[0]!] = false;
    }
}

export type PanelLayout = {
    visible: Record<Panel, boolean>;
    /** The tabs panel is shown and maximized: it has the main column's width as well. */
    maximized: boolean;
    /** The main column's width, as if not maximized. */
    mainWidth: number;
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
export function panelLayout(viewport: number, state: FitInput, maximize = false): PanelLayout {
    const visible = fitPanels(viewport, state);
    const shown = PANELS.filter((p) => visible[p]);
    const minimums = shown.reduce((sum, p) => sum + PANEL_WIDTHS[p].min, 0);
    const main = clamp(viewport - minimums, MAIN_MIN_WIDTH, MAIN_COMFORT_WIDTH);

    const widths = perPanel(() => 0);
    for (const p of shown) widths[p] = clampWidth(p, state.widths[p]);
    let excess = shown.reduce((sum, p) => sum + widths[p], 0) - (viewport - main);
    for (const p of byUse(shown, state)) {
        if (excess <= 0) break;
        const cut = Math.min(excess, widths[p] - PANEL_WIDTHS[p].min);
        widths[p] -= cut;
        excess -= cut;
    }

    const dragMax = perPanel(() => 0);
    for (const p of shown) {
        const others = shown
            .filter((o) => o !== p)
            .reduce((sum, o) => sum + PANEL_WIDTHS[o].min, 0);
        dragMax[p] = Math.max(
            PANEL_WIDTHS[p].min,
            Math.min(PANEL_WIDTHS[p].max, viewport - main - others)
        );
    }

    const mainWidth = viewport - shown.reduce((sum, p) => sum + widths[p], 0);
    const maximized = maximize && visible.tabs;
    if (maximized) widths.tabs += mainWidth;
    return { visible, maximized, mainWidth, widths, dragMax };
}

/** Version 0 named panels by their old fixed sides. */
type SavedV0 = {
    sidebarOpen?: boolean;
    rightSidebarOpen?: boolean;
    filesOpen?: boolean;
    sidebarWidth?: number;
    rightSidebarWidth?: number;
    filesWidth?: number;
    usedAt?: { left?: number; right?: number; files?: number };
};

const migrateV0 = (saved: SavedV0): Partial<FitInput> => ({
    open: {
        chats: saved.sidebarOpen ?? true,
        tabs: saved.rightSidebarOpen ?? false,
        files: saved.filesOpen ?? false
    },
    widths: {
        chats: saved.sidebarWidth ?? PANEL_WIDTHS.chats.default,
        tabs: saved.rightSidebarWidth ?? PANEL_WIDTHS.tabs.default,
        files: saved.filesWidth ?? PANEL_WIDTHS.files.default
    },
    usedAt: {
        chats: saved.usedAt?.left ?? 0,
        tabs: saved.usedAt?.right ?? 0,
        files: saved.usedAt?.files ?? 0
    }
});

let slideTimer: ReturnType<typeof setTimeout> | undefined;

/** Which panels are open and how wide; persisted per device. Where they sit is a setting (`placement.ts`). */
export const useLayoutStore = create<LayoutState>()(
    persist(
        (set, get) => {
            /** Maximizes or restores; `sliding` until the slide is over. */
            const slide = (maximized: boolean) => {
                clearTimeout(slideTimer);
                slideTimer = setTimeout(() => set({ sliding: false }), SLIDE_MS + 50);
                return { maximized, sliding: true };
            };
            const shownNow = (panel: Panel) => {
                const state = get();
                return state.open[panel] && fitPanels(roomWidth(), state)[panel];
            };
            return {
                open: { chats: true, tabs: false, files: false },
                widths: perPanel((p) => PANEL_WIDTHS[p].default),
                usedAt: perPanel(() => 0),
                resizing: false,
                maximized: false,
                sliding: false,
                toggle: (panel) => {
                    const state = get();
                    const shown = shownNow(panel);
                    set({
                        open: { ...state.open, [panel]: !shown },
                        ...(!shown && { usedAt: { ...state.usedAt, [panel]: Date.now() } }),
                        // A maximized panel that closes opens again restored.
                        ...(shown && panel === "tabs" && { maximized: false })
                    });
                },
                toggleMaximized: () => {
                    const state = get();
                    const shown = shownNow("tabs");
                    const maximize = !(state.maximized && shown);
                    set({
                        ...slide(maximize),
                        ...(maximize && {
                            open: { ...state.open, tabs: true },
                            usedAt: { ...state.usedAt, tabs: Date.now() }
                        })
                    });
                },
                setWidth: (panel, width) =>
                    set((s) => ({ widths: { ...s.widths, [panel]: clampWidth(panel, width) } })),
                touch: (panel) => set((s) => ({ usedAt: { ...s.usedAt, [panel]: Date.now() } })),
                setResizing: (resizing) => set({ resizing })
            };
        },
        {
            name: "outcode.layout",
            version: 1,
            storage: createJSONStorage(() => localStorage),
            partialize: (s): FitInput => ({ open: s.open, widths: s.widths, usedAt: s.usedAt }),
            migrate: (saved, version) =>
                (version === 0 ? migrateV0(saved as SavedV0) : saved) as LayoutState,
            // Fills panels the save doesn't know; a width from before the limits changed snaps into them.
            merge: (saved, current) => {
                const s = (saved ?? {}) as Partial<FitInput>;
                const widths = { ...current.widths, ...s.widths };
                return {
                    ...current,
                    open: { ...current.open, ...s.open },
                    widths: perPanel((p) => clampWidth(p, widths[p])),
                    usedAt: { ...current.usedAt, ...s.usedAt }
                };
            }
        }
    )
);

/** The layout for the window's width right now, outside React. */
export const getPanelLayout = () => {
    const state = useLayoutStore.getState();
    return panelLayout(roomWidth(), state, state.maximized);
};

const subscribeResize = (onChange: () => void) => {
    window.addEventListener("resize", onChange);
    return () => window.removeEventListener("resize", onChange);
};

const useViewportWidth = () => useSyncExternalStore(subscribeResize, roomWidth);

/** The panels shown and their widths, for the window's current width. */
export function usePanelLayout(): PanelLayout {
    const viewport = useViewportWidth();
    const state = useLayoutStore(
        useShallow((s) => ({ open: s.open, widths: s.widths, usedAt: s.usedAt }))
    );
    const maximized = useLayoutStore((s) => s.maximized);
    return useMemo(() => panelLayout(viewport, state, maximized), [viewport, state, maximized]);
}

/** A panel is open and has room to show. */
export const usePanelShown = (panel: Panel) => usePanelLayout().visible[panel];

/** A panel's shown width: 0 while closed or hidden for room. */
export const usePanelWidth = (panel: Panel) => usePanelLayout().widths[panel];
