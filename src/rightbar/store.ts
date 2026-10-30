import { create } from "zustand";

/**
 * What a tab shows: a file of a chat's folder in the editor, or a terminal
 * started in a folder (the home folder without one), or the diff or history
 * of the open chat's folder (they follow the open chat, as zeron's Diff and
 * History tabs do), or what one commit of a folder changed.
 */
export type TabContent =
    | { kind: "file"; cwd: string; path: string }
    | { kind: "terminal"; cwd: string | null }
    | { kind: "diff" }
    | { kind: "history" }
    | { kind: "commit"; cwd: string; sha: string; subject: string };

export type RightTab = { id: string; title: string } & TabContent;

type RightbarState = {
    tabs: RightTab[];
    activeId: string | null;
    /** Adds a tab after the others and shows it; its id. */
    add: (content: TabContent, title: string) => string;
    activate: (id: string) => void;
    retitle: (id: string, title: string) => void;
    /** Points a file tab at `path` (its file was renamed), titled `title`. */
    repath: (id: string, path: string, title: string) => void;
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
    retitle: (id, title) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),
    repath: (id, path, title) =>
        set((s) => ({
            tabs: s.tabs.map((t) => (t.id === id && t.kind === "file" ? { ...t, path, title } : t))
        })),
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
