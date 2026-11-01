import { useEffect } from "react";
import { isBusy, useChatsStore, workDir } from "@/chats";
import { checkAllOnDisk, checkDisk, useDocsStore } from "@/editor";
import { watchFolder, type FolderChange } from "@/lib/folderWatch";
import { onWindowFocus } from "@/lib/windowFocus";

/** The folder `path` (relative to `cwd`, `/`-separated) is directly in, and its name. */
function splitPath(cwd: string, path: string): [folder: string, name: string] {
    const slash = path.lastIndexOf("/");
    if (slash === -1) return [cwd, path];
    return [`${cwd}/${path.slice(0, slash)}`, path.slice(slash + 1)];
}

/**
 * Looks at open files on disk again when they may have changed: a watch on
 * each one's folder (just that folder) sees it written, removed, or HEAD
 * moving under it; the window regaining focus and an agent's turn ending in
 * their folder catch anything a watch missed.
 */
export function useDiskChecks() {
    useEffect(() => {
        const stopFocus = onWindowFocus(() => checkAllOnDisk());
        const unsubscribe = useChatsStore.subscribe((state, previous) => {
            for (const chat of state.chats) {
                const was = previous.sessions[chat.id]?.status;
                const now = state.sessions[chat.id]?.status;
                if (isBusy(was) && !isBusy(now)) checkAllOnDisk(workDir(chat));
            }
        });
        return () => {
            stopFocus();
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        /** Each watched folder's unsubscribe. */
        const watched = new Map<string, () => void>();

        const onChange = (folder: string) => (change: FolderChange) => {
            const names = new Set(change.paths);
            for (const [id, doc] of Object.entries(useDocsStore.getState().docs)) {
                const [docFolder, name] = splitPath(doc.cwd, doc.path);
                if (docFolder !== folder) continue;
                if (change.overflow || change.git || names.has(name)) void checkDisk(id);
            }
        };

        const sync = () => {
            const wanted = new Set(
                Object.values(useDocsStore.getState().docs).map(
                    (doc) => splitPath(doc.cwd, doc.path)[0]
                )
            );
            for (const [folder, stop] of watched) {
                if (!wanted.has(folder)) {
                    stop();
                    watched.delete(folder);
                }
            }
            for (const folder of wanted) {
                if (!watched.has(folder)) watched.set(folder, watchFolder(folder, onChange(folder), false));
            }
        };

        sync();
        const unsubscribe = useDocsStore.subscribe((state, previous) => {
            if (state.docs !== previous.docs) sync();
        });
        return () => {
            unsubscribe();
            for (const stop of watched.values()) stop();
        };
    }, []);
}
