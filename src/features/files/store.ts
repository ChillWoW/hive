import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { LinePosition } from "@/features/editor/documents";
import { openFileTab } from "@/features/editor/open";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { ancestorsOf, isUnder, movedPath } from "./tree";

/** What a text search may be told, besides the text. */
export type SearchOption = "caseSensitive" | "wholeWord" | "regex";

type FilesState = {
    /** The search field's text; lists what it finds instead of the tree while not blank. */
    query: string;
    /** What the search looks through: the files' names, or their text. */
    mode: "names" | "text";
    caseSensitive: boolean;
    wholeWord: boolean;
    regex: boolean;
    /** Goes up when the search field should take the caret. */
    focusSearch: number;
    /** Open folders, by the root they're under. */
    expanded: Record<string, string[]>;
    /** The picked entry, by root. */
    selected: Record<string, string>;
    /** What `.gitignore` hides shows too, dimmed. */
    showIgnored: boolean;
};

/** The file panel's search, open folders and pick; open folders and `showIgnored` persist per device. */
export const useFilesStore = create<FilesState>()(
    persist(
        (): FilesState => ({
            query: "",
            mode: "names",
            caseSensitive: false,
            wholeWord: false,
            regex: false,
            focusSearch: 0,
            expanded: {},
            selected: {},
            showIgnored: false
        }),
        {
            name: "outcode.files",
            version: 0,
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ expanded: s.expanded, showIgnored: s.showIgnored })
        }
    )
);

const NO_FOLDERS: readonly string[] = [];

/** `root`'s open folders. */
export const useExpanded = (root: string) => useFilesStore((s) => s.expanded[root] ?? NO_FOLDERS);

const setExpanded = (root: string, update: (open: Set<string>) => void) =>
    useFilesStore.setState((s) => {
        const open = new Set(s.expanded[root]);
        update(open);
        return { expanded: { ...s.expanded, [root]: [...open] } };
    });

/** File panel actions, outside React too. Paths are relative to `root`, `/`-separated. */
export const files = {
    setQuery: (query: string) => useFilesStore.setState({ query }),
    setMode: (mode: FilesState["mode"]) => useFilesStore.setState({ mode }),
    toggleOption: (option: SearchOption) => useFilesStore.setState((s) => ({ [option]: !s[option] })),
    /** Shows the file panel, set to search the files' text, with the caret in its search field. */
    searchText: () => {
        if (!getPanelLayout().visible.files) useLayoutStore.getState().toggle("files");
        useFilesStore.setState((s) => ({ mode: "text", focusSearch: s.focusSearch + 1 }));
    },
    toggleIgnored: () => useFilesStore.setState((s) => ({ showIgnored: !s.showIgnored })),
    toggleFolder: (root: string, path: string) =>
        setExpanded(root, (open) => (open.has(path) ? open.delete(path) : open.add(path))),
    setFolderOpen: (root: string, path: string, on: boolean) =>
        setExpanded(root, (open) => (on ? open.add(path) : open.delete(path))),
    /** Folds every folder under `root`. */
    collapseAll: (root: string) =>
        useFilesStore.setState((s) => ({ expanded: { ...s.expanded, [root]: [] } })),
    select: (root: string, path: string) =>
        useFilesStore.setState((s) => ({ selected: { ...s.selected, [root]: path } })),
    /** Opens the folders around `path` and picks it, so the tree shows it. */
    reveal: (root: string, path: string) => {
        setExpanded(root, (open) => ancestorsOf(path).forEach((folder) => open.add(folder)));
        files.select(root, path);
    },
    /** Follows a rename: open folders and the pick at or under `from` are under `to` now. */
    moved: (root: string, from: string, to: string) =>
        useFilesStore.setState((s) => {
            const pick = s.selected[root];
            return {
                expanded: {
                    ...s.expanded,
                    [root]: (s.expanded[root] ?? []).map((path) => movedPath(path, from, to))
                },
                selected: pick === undefined ? s.selected : { ...s.selected, [root]: movedPath(pick, from, to) }
            };
        }),
    /** Forgets the open folders and the pick at or under `path`, which is gone. */
    removed: (root: string, path: string) =>
        useFilesStore.setState((s) => {
            const { [root]: pick, ...others } = s.selected;
            return {
                expanded: {
                    ...s.expanded,
                    [root]: (s.expanded[root] ?? []).filter((open) => !isUnder(open, path))
                },
                selected: pick !== undefined && isUnder(pick, path) ? others : s.selected
            };
        }),
    /** Picks a file and opens it in an editor tab; with `at`, at that line. */
    open: (root: string, path: string, at?: LinePosition) => {
        files.select(root, path);
        openFileTab(root, path, at);
    }
};
