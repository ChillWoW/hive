import { useEffect } from "react";
import { create } from "zustand";
import { useTurnEnded } from "@/git/store";
import { backend } from "@/lib/backend";
import { touchesTree, useFolderWatch } from "@/lib/folderWatch";
import { singleFlight } from "@/lib/singleFlight";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitFileState, GitFileStatus } from "@/proto";

/**
 * The file panel's git marks, after Zed's project panel: a changed file's
 * name in its state's colour with a letter at the row's end; a folder's in
 * the colour of what's inside it, with a dot.
 */

/** A path's states as bits; a folder's are its contents' together. */
const BIT: Record<GitFileState, number> = {
    conflict: 1,
    untracked: 2,
    deleted: 4,
    modified: 8,
    added: 16
};

export type GitMarks = {
    /** Each listed path's bits (files exact, folders their contents'). */
    paths: Map<string, number>;
    /** Untracked folders ("" for all of it): everything under them is untracked. */
    untracked: string[];
};

const EMPTY: GitMarks = { paths: new Map(), untracked: [] };

function marksOf(files: GitFileStatus[]): GitMarks {
    const paths = new Map<string, number>();
    const untracked: string[] = [];
    const add = (path: string, bit: number) => paths.set(path, (paths.get(path) ?? 0) | bit);
    for (const { path, state } of files) {
        const bit = BIT[state];
        if (path === "" || path.endsWith("/")) {
            const dir = path.replace(/\/$/, "");
            untracked.push(dir);
            if (dir) add(dir, bit);
        } else {
            add(path, bit);
        }
        // Every folder above it.
        for (let i = path.lastIndexOf("/", path.length - 2); i > 0; i = path.lastIndexOf("/", i - 1)) {
            add(path.slice(0, i), bit);
        }
    }
    return { paths, untracked };
}

/** `path`'s bits: its own, or untracked when a folder above it is. */
export function marksFor(marks: GitMarks, path: string): number {
    const own = marks.paths.get(path) ?? 0;
    const inUntracked = marks.untracked.some(
        (dir) => dir === "" || path === dir || path.startsWith(`${dir}/`)
    );
    return inUntracked ? own | BIT.untracked : own;
}

/** The name's colour; Zed's order: conflict, deleted, modified, created. */
export function markColor(bits: number): string | undefined {
    if (bits & BIT.conflict) return "text-danger";
    if (bits & BIT.deleted) return "text-danger";
    if (bits & BIT.modified) return "text-warning";
    if (bits & (BIT.added | BIT.untracked)) return "text-success";
    return undefined;
}

/** A file's letter at the row's end, with its colour; Zed's order. */
export function markLetter(bits: number): { letter: string; label: string; color: string } | null {
    if (bits & BIT.conflict) return { letter: "!", label: "Conflict", color: "text-danger" };
    if (bits & BIT.untracked) return { letter: "U", label: "Untracked", color: "text-success" };
    if (bits & BIT.deleted) return { letter: "D", label: "Deleted", color: "text-danger" };
    if (bits & BIT.modified) return { letter: "M", label: "Modified", color: "text-warning" };
    if (bits & BIT.added) return { letter: "A", label: "Added", color: "text-success" };
    return null;
}

const useGitMarksStore = create<{ marks: Record<string, GitMarks> }>()(() => ({ marks: {} }));

const reads = singleFlight<string>();

function refresh(cwd: string, fresh = false) {
    return reads(
        cwd,
        () =>
            backend<GitFileStatus[] | null>("git_status", { cwd }, () => [
                { path: "src/App.tsx", state: "modified" },
                { path: "src/rightbar/kinds.ts", state: "modified" },
                { path: "notes.md", state: "untracked" }
            ]).then(
                (files) =>
                    useGitMarksStore.setState((s) => ({
                        marks: { ...s.marks, [cwd]: files ? marksOf(files) : EMPTY }
                    })),
                // The last marks stay; the tree works without them.
                (error: unknown) => console.warn("[files] git status failed", cwd, error)
            ),
        fresh
    );
}

/**
 * `cwd`'s marks, read while mounted: at first, when a file or the git dir
 * changes (the folder watch), on window focus and when a turn there ends.
 */
export function useGitMarks(cwd: string): GitMarks {
    const marks = useGitMarksStore((s) => s.marks[cwd]);

    useEffect(() => {
        void refresh(cwd);
        return onWindowFocus(() => void refresh(cwd));
    }, [cwd]);

    useFolderWatch(cwd, (change) => {
        if (touchesTree(change)) void refresh(cwd, true);
    });

    useTurnEnded(cwd, () => void refresh(cwd));

    return marks ?? EMPTY;
}
