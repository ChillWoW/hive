import { create } from "zustand";

/** What a tab shows. Only mock tabs so far, to try the strip with. */
export type TabKind = "mock";

export type RightTab = { id: string; kind: TabKind; title: string };

type RightbarState = {
    tabs: RightTab[];
    activeId: string | null;
    /** Adds a tab after the others and shows it. */
    open: (kind: TabKind, title: string) => void;
    activate: (id: string) => void;
    /** Closes a tab; closing the shown one shows its right neighbour, else its left. */
    close: (id: string) => void;
    /** Moves the tab at `from` to `to`. */
    move: (from: number, to: number) => void;
};

let nextId = 0;
const mock = (title: string): RightTab => ({ id: `tab-${++nextId}`, kind: "mock", title });

const SEED = [mock("Mock tab 1"), mock("Mock tab 2"), mock("A mock tab with a long title")];

/** The right sidebar's tabs, as zeron's right pane keeps its surfaces. */
export const useRightbarStore = create<RightbarState>()((set) => ({
    tabs: SEED,
    activeId: SEED[0]!.id,
    open: (kind, title) => {
        const tab = { id: `tab-${++nextId}`, kind, title };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },
    activate: (activeId) => set({ activeId }),
    close: (id) =>
        set((s) => {
            const index = s.tabs.findIndex((t) => t.id === id);
            if (index === -1) return s;
            const tabs = s.tabs.filter((t) => t.id !== id);
            const activeId =
                s.activeId === id
                    ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
                    : s.activeId;
            return { tabs, activeId };
        }),
    move: (from, to) =>
        set((s) => {
            if (from === to) return s;
            const tabs = [...s.tabs];
            const [tab] = tabs.splice(from, 1);
            tabs.splice(to, 0, tab!);
            return { tabs };
        })
}));
