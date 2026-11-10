import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type Side = "left" | "right";

/** Each sidebar's widths in px. */
export const SIDEBAR_WIDTHS: Record<Side, { min: number; max: number; default: number }> = {
    left: { min: 220, max: 480, default: 280 },
    right: { min: 360, max: 960, default: 520 }
};

/** A drag never squeezes the main column narrower than this. */
export const MAIN_MIN_WIDTH = 300;

const clampWidth = (side: Side, width: number) => {
    const { min, max } = SIDEBAR_WIDTHS[side];
    return Math.round(Math.min(Math.max(width, min), max));
};

const OPEN_KEY = { left: "sidebarOpen", right: "rightSidebarOpen" } as const;
const WIDTH_KEY = { left: "sidebarWidth", right: "rightSidebarWidth" } as const;

type LayoutState = {
    sidebarOpen: boolean;
    rightSidebarOpen: boolean;
    /** Widths while open. */
    sidebarWidth: number;
    rightSidebarWidth: number;
    /** An edge is being dragged: widths follow the pointer, unanimated. */
    resizing: boolean;
    toggle: (side: Side) => void;
    /** Clamped to the side's min and max. */
    setWidth: (side: Side, width: number) => void;
    setResizing: (resizing: boolean) => void;
};

/** Which sidebars are open and how wide; persisted per device. */
export const useLayoutStore = create<LayoutState>()(
    persist(
        (set) => ({
            sidebarOpen: true,
            rightSidebarOpen: false,
            sidebarWidth: SIDEBAR_WIDTHS.left.default,
            rightSidebarWidth: SIDEBAR_WIDTHS.right.default,
            resizing: false,
            toggle: (side) => set((s) => ({ [OPEN_KEY[side]]: !s[OPEN_KEY[side]] })),
            setWidth: (side, width) => set({ [WIDTH_KEY[side]]: clampWidth(side, width) }),
            setResizing: (resizing) => set({ resizing })
        }),
        {
            name: "outcode.layout",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({
                sidebarOpen: s.sidebarOpen,
                rightSidebarOpen: s.rightSidebarOpen,
                sidebarWidth: s.sidebarWidth,
                rightSidebarWidth: s.rightSidebarWidth
            }),
            // A saved width from before the limits changed snaps into them.
            merge: (saved, current) => {
                const merged = { ...current, ...(saved as Partial<LayoutState>) };
                return {
                    ...merged,
                    sidebarWidth: clampWidth("left", merged.sidebarWidth),
                    rightSidebarWidth: clampWidth("right", merged.rightSidebarWidth)
                };
            }
        }
    )
);

export const isSidebarOpen = (side: Side) => useLayoutStore.getState()[OPEN_KEY[side]];
export const getSidebarWidth = (side: Side) => useLayoutStore.getState()[WIDTH_KEY[side]];

export const useSidebarOpen = (side: Side) => useLayoutStore((s) => s[OPEN_KEY[side]]);

/** A sidebar's width while open, even while closed. */
export const useSidebarContentWidth = (side: Side) => useLayoutStore((s) => s[WIDTH_KEY[side]]);

/** A sidebar's shown width: 0 while closed. */
export const useSidebarWidth = (side: Side) =>
    useLayoutStore((s) => (s[OPEN_KEY[side]] ? s[WIDTH_KEY[side]] : 0));
