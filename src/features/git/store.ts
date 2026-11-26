import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useChatsStore } from "@/features/chats/store";
import { errorMessage } from "@/lib/errors";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitRepo } from "@/proto";
import { gitApi } from "./api";

/**
 * Each folder's checkout (`GitRepo`, null outside one). Read on demand and
 * again when it may have changed: the window regaining focus, an agent's
 * turn in the folder ending, the picker opening, or one of the actions here.
 */

interface Entry {
    repo: GitRepo | null;
    loadedAt: number;
}

const useGitStore = create<{ repos: Record<string, Entry> }>()(() => ({ repos: {} }));

/** The read running per folder; a second refresh joins it. */
const reads = new Map<string, Promise<void>>();

/**
 * Reads `cwd`'s checkout again, one read at a time per folder. With `fresh`,
 * a read already running is followed by another (it may predate a change).
 */
function refresh(cwd: string, fresh = false): Promise<void> {
    const running = reads.get(cwd);
    if (running && !fresh) return running;
    const read: Promise<void> = (running ?? Promise.resolve())
        .then(() => gitApi.repo(cwd))
        // A failed read keeps what was known.
        .then(
            (repo) => repo,
            () => useGitStore.getState().repos[cwd]?.repo ?? null
        )
        .then((repo) => {
            useGitStore.setState((s) => ({ repos: { ...s.repos, [cwd]: { repo, loadedAt: Date.now() } } }));
        })
        .finally(() => {
            if (reads.get(cwd) === read) reads.delete(cwd);
        });
    reads.set(cwd, read);
    return read;
}

/** Older than this, a mounted reader reads again. */
const MAX_AGE = 5_000;

/** `cwd`'s checkout: undefined until first read, null outside a checkout. */
export function useGitRepo(cwd: string | null | undefined): GitRepo | null | undefined {
    const entry = useGitStore((s) => (cwd ? s.repos[cwd] : undefined));
    const busy = useFolderBusy(cwd);
    const wasBusy = useRef(busy);

    useEffect(() => {
        const ended = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (!cwd) return;
        const known = useGitStore.getState().repos[cwd];
        // A turn may have switched or made a branch.
        if (ended || !known || Date.now() - known.loadedAt > MAX_AGE) void refresh(cwd);
    }, [cwd, busy]);

    useEffect(() => {
        if (!cwd) return;
        return onWindowFocus(() => void refresh(cwd));
    }, [cwd]);

    return entry?.repo;
}

/** An agent is mid-turn in `cwd`, so the branch there shouldn't move under it. */
export function useFolderBusy(cwd: string | null | undefined) {
    return useChatsStore((s) => !!cwd && s.chats.some((c) => c.cwd === cwd && !!s.sessions[c.id]?.working));
}

/**
 * A git action at a time: `busy` while it runs, its failure as `error`.
 * `run` resolves to whether it succeeded.
 */
export function useGitAction() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            return true;
        } catch (e) {
            setError(errorMessage(e, "Git failed."));
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, setError, run };
}

/** Each action re-reads the folder afterwards, failed or not. */
async function then(cwd: string, action: Promise<void>): Promise<void> {
    try {
        await action;
    } finally {
        await refresh(cwd, true);
    }
}

export const git = {
    refresh,
    switchBranch: (cwd: string, name: string) => then(cwd, gitApi.switchBranch(cwd, name)),
    createBranch: (cwd: string, name: string, from: string) => then(cwd, gitApi.createBranch(cwd, name, from)),
    deleteBranch: (cwd: string, name: string) => then(cwd, gitApi.deleteBranch(cwd, name))
};
