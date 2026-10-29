import { create } from "zustand";

/** What a tab shows: a file of a chat's folder in the editor. */
export type TabContent = { kind: "file"; cwd: string; path: string };

export type RightTab = { id: string; title: string } & TabContent;

type RightbarState = {
    tabs: RightTab[];
    activeId: string | null;
    /** Adds a tab after the others and shows it; its id. */
    add: (content: TabContent, title: string) => string;
    activate: (id: string) => void;
    /** Takes a tab away; the shown one passes to its right neighbour, else its left. */
    remove: (id: string) => void;
    /** Moves the tab at `from` to `to`. */
    move: (from: number, to: number) => void;
};

let nextId = 0;

/** The right sidebar's tabs, as zeron's right pane keeps its surfaces. */
export const useRightbarStore = create<RightbarState>()((set) => ({
    tabs: [],
    activeId: null,
    add: (content, title) => {
        const tab: RightTab = { id: `tab-${++nextId}`, title, ...content };
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
    },
    activate: (activeId) => set({ activeId }),
    remove: (id) =>
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
