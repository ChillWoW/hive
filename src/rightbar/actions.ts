import { blockClose, dropDoc, openDoc, save, useDocsStore } from "@/editor";
import { useLayoutStore } from "@/stores/useLayoutStore";
import { useRightbarStore } from "./store";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Opens `path` of `cwd` in a tab (the one it's already in, if any) and shows
 * the right sidebar, as zeron opens a file from its tree.
 */
export function openFileTab(cwd: string, path: string) {
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find((t) => t.kind === "file" && t.cwd === cwd && t.path === path);
    if (open) activate(open.id);
    else void openDoc(add({ kind: "file", cwd, path }, nameOf(path)), cwd, path);
    useLayoutStore.getState().show("right");
}

/** Closes a tab, saving its file first; a failed save keeps it open and says so. */
export async function closeTab(id: string) {
    const doc = useDocsStore.getState().docs[id];
    if (doc?.dirty && !(await save(id))) {
        blockClose(id);
        useRightbarStore.getState().activate(id);
        return;
    }
    discardTab(id);
}

/** Closes a tab, unsaved changes and all. */
export function discardTab(id: string) {
    useRightbarStore.getState().remove(id);
    dropDoc(id);
}
