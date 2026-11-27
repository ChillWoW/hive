import { useEffect, useRef } from "react";
import { create } from "zustand";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitFileState } from "@/proto";
import { watchFiles } from "@/features/files/watch";
import { gitApi } from "./api";
import { useFolderBusy } from "./store";

/**
 * Each folder's uncommitted files (`git status`), for the file tree's marks.
 * Read while something shows them and again when they may have changed: a
 * file under the folder changing on disk (`watchFiles`), the window
 * regaining focus, every few seconds while an agent works in the
 * folder and once its turn ends, or a `refreshGitStatus` after a save, a
 * rename or a delete.
 */

/** A folder's uncommitted files, by path from it (`/`-separated). */
export type GitStatus = Readonly<Record<string, GitFileState>>;

/** What a tree row is marked as; a folder goes by the files under it. */
export type GitMark = "modified" | "added" | "conflict";

const useStatusStore = create<{ statuses: Record<string, GitStatus | null> }>()(() => ({ statuses: {} }));

/** While an agent works in the folder, its status is read again this often. */
const BUSY_POLL_MS = 3_000;

const reads = new Map<string, Promise<void>>();
/** Folders whose running read may predate a change: read once more after it. */
const stale = new Set<string>();

const same = (a: GitStatus | null | undefined, b: GitStatus | null) => {
    if (!a || !b) return a === b;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((path) => a[path] === b[path]);
};

/** Reads `cwd`'s status again, one read at a time per folder. */
export function refreshGitStatus(cwd: string): Promise<void> {
    if (!cwd) return Promise.resolve();
    const running = reads.get(cwd);
    if (running) {
        stale.add(cwd);
        return running;
    }
    const read = gitApi
        .status(cwd)
        .then(
            (next) =>
                // The same status keeps its object, so the tree isn't marked again.
                useStatusStore.setState((s) =>
                    same(s.statuses[cwd], next) ? s : { statuses: { ...s.statuses, [cwd]: next } }
                ),
            // A failed read keeps what was known.
            (error: unknown) => console.warn("[git] status failed", error)
        )
        .finally(() => {
            reads.delete(cwd);
            if (stale.delete(cwd)) void refreshGitStatus(cwd);
        });
    reads.set(cwd, read);
    return read;
}

/**
 * `cwd`'s uncommitted files, kept current while `active`; undefined until
 * first read, null outside a checkout.
 */
export function useGitStatus(cwd: string, active: boolean): GitStatus | null | undefined {
    const status = useStatusStore((s) => (cwd ? s.statuses[cwd] : undefined));
    const busy = useFolderBusy(cwd);

    useEffect(() => {
        if (!cwd || !active) return;
        void refreshGitStatus(cwd);
        const unfocus = onWindowFocus(() => void refreshGitStatus(cwd));
        const unwatch = watchFiles(cwd, () => void refreshGitStatus(cwd));
        return () => {
            unfocus();
            unwatch();
        };
    }, [cwd, active]);

    const wasBusy = useRef(busy);
    useEffect(() => {
        const ended = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (!cwd || !active) return;
        if (ended) void refreshGitStatus(cwd);
        if (!busy) return;
        const timer = setInterval(() => void refreshGitStatus(cwd), BUSY_POLL_MS);
        return () => clearInterval(timer);
    }, [cwd, active, busy]);

    return status;
}

const MARK: Record<GitFileState, GitMark> = {
    added: "added",
    untracked: "added",
    modified: "modified",
    renamed: "modified",
    deleted: "modified",
    conflict: "conflict"
};

const WEIGHT: Record<GitMark, number> = { added: 0, modified: 1, conflict: 2 };

/**
 * Each changed file's mark, and each folder's from the files under it: a
 * conflict first, then anything changed or gone, else all new.
 */
export function gitMarks(status: GitStatus): Map<string, GitMark> {
    const marks = new Map<string, GitMark>();
    for (const [path, state] of Object.entries(status)) {
        const mark = MARK[state];
        marks.set(path, mark);
        for (let slash = path.lastIndexOf("/"); slash !== -1; slash = path.lastIndexOf("/", slash - 1)) {
            const folder = path.slice(0, slash);
            const known = marks.get(folder);
            if (known === undefined || WEIGHT[mark] > WEIGHT[known]) marks.set(folder, mark);
        }
    }
    return marks;
}
