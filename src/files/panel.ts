import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { TextSearchOptions } from "@/proto";
import { useLayoutStore } from "@/stores/useLayoutStore";

/** What the search field looks for: file names, or text inside files. */
export type SearchMode = "files" | "text";

type FilesPanelState = {
    /** What the file panel's search field holds. */
    query: string;
    mode: SearchMode;
    /** How the text search reads the query. */
    textOptions: TextSearchOptions;
    /** Lists hidden and git-ignored files too. */
    showAll: boolean;
    /** Each folder's expanded subfolders, by path. */
    expanded: Record<string, string[]>;
    /** The highlighted row's path. */
    selected: string | null;
    /** A path the tree should scroll to once its row is there. */
    reveal: string | null;
    /** Bumped to focus the search field (`openFileSearch`). */
    searchFocus: number;
    setQuery: (query: string) => void;
    setMode: (mode: SearchMode) => void;
    toggleTextOption: (option: keyof TextSearchOptions) => void;
    toggleShowAll: () => void;
    toggleExpanded: (cwd: string, path: string) => void;
    /** Closes every expanded folder in `cwd`'s tree. */
    collapseAll: (cwd: string) => void;
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
            mode: "files",
            textOptions: { caseSensitive: false, wholeWord: false, regex: false },
            showAll: false,
            expanded: {},
            selected: null,
            reveal: null,
            searchFocus: 0,
            setQuery: (query) => set({ query }),
            setMode: (mode) => set({ mode }),
            toggleTextOption: (option) =>
                set((s) => ({
                    textOptions: { ...s.textOptions, [option]: !s.textOptions[option] }
                })),
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
            collapseAll: (cwd) => set((s) => ({ expanded: { ...s.expanded, [cwd]: [] } })),
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
            partialize: (s) => ({
                showAll: s.showAll,
                expanded: s.expanded,
                mode: s.mode,
                textOptions: s.textOptions
            })
        }
    )
);

/**
 * Shows the file panel with its search field focused, its text selected,
 * searching file names (or, with `mode`, what it says).
 */
export function openFileSearch(mode: SearchMode = "files") {
    useLayoutStore.getState().show("files");
    useFilesPanelStore.setState((s) => ({ mode, searchFocus: s.searchFocus + 1 }));
}

/** Shows the file panel searching the text inside files (Mod+Shift+F). */
export const openTextSearch = () => openFileSearch("text");
