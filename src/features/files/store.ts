import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { ancestorsOf } from "./tree";

type FilesState = {
    /** The search field's text; lists matching files instead of the tree while not blank. */
    query: string;
    /** Open folders, by the root they're under. */
    expanded: Record<string, string[]>;
    /** The picked entry, by root. */
    selected: Record<string, string>;
    /** What `.gitignore` hides shows too, dimmed. */
    showIgnored: boolean;
};

/** The file panel's search, open folders and pick; open folders and `showIgnored` persist per device. */
export const useFilesStore = create<FilesState>()(
    persist(() => ({ query: "", expanded: {}, selected: {}, showIgnored: false }), {
        name: "outcode.files",
        version: 0,
        storage: createJSONStorage(() => localStorage),
        partialize: (s) => ({ expanded: s.expanded, showIgnored: s.showIgnored })
    })
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
    /** Picks a file. Opening it in an editor tab is still to come. */
    open: (root: string, path: string) => files.select(root, path)
};
