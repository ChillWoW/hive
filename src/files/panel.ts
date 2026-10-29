import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type FilesPanelState = {
    /** What the file panel's search field holds. */
    query: string;
    /** Lists hidden and git-ignored files too. */
    showAll: boolean;
    /** Each folder's expanded subfolders, by path. */
    expanded: Record<string, string[]>;
    /** The highlighted row's path. */
    selected: string | null;
    /** A path the tree should scroll to once its row is there. */
    reveal: string | null;
    setQuery: (query: string) => void;
    toggleShowAll: () => void;
    toggleExpanded: (cwd: string, path: string) => void;
    select: (path: string | null) => void;
    /** Opens the folders down to `path` in the tree, selects it and ends the search. */
    revealPath: (cwd: string, path: string, dir: boolean) => void;
    clearReveal: () => void;
};

/** "a/b/c" → ["a", "a/b"]. */
const ancestors = (path: string) =>
    path
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/"));

export const useFilesPanelStore = create<FilesPanelState>()(
    persist(
        (set) => ({
            query: "",
            showAll: false,
            expanded: {},
            selected: null,
            reveal: null,
            setQuery: (query) => set({ query }),
            toggleShowAll: () => set((s) => ({ showAll: !s.showAll })),
            toggleExpanded: (cwd, path) =>
                set((s) => {
                    const open = s.expanded[cwd] ?? [];
                    return {
                        expanded: {
                            ...s.expanded,
                            [cwd]: open.includes(path)
                                ? open.filter((p) => p !== path)
                                : [...open, path]
                        }
                    };
                }),
            select: (selected) => set({ selected }),
            revealPath: (cwd, path, dir) =>
                set((s) => {
                    const open = new Set(s.expanded[cwd]);
                    for (const folder of ancestors(path)) open.add(folder);
                    if (dir) open.add(path);
                    return {
                        expanded: { ...s.expanded, [cwd]: [...open] },
                        selected: path,
                        reveal: path,
                        query: ""
                    };
                }),
            clearReveal: () => set({ reveal: null })
        }),
        {
            name: "hive.filesPanel",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ showAll: s.showAll, expanded: s.expanded })
        }
    )
);
