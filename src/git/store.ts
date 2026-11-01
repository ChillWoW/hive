import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { isBusy, useChatsStore, workDir } from "@/chats";
import { errorMessage } from "@/lib/errors";
import { touchesTree, useFolderWatch } from "@/lib/folderWatch";
import { singleFlight } from "@/lib/singleFlight";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitRepo } from "@/proto";
import { gitApi } from "./api";

/**
 * Each folder's checkout (`GitRepo`, null outside one), shared by the branch
 * picker and the sidebar's chat cards. Read on demand and again when it may
 * have changed: the folder or its git dir changing (a folder watch), the
 * window regaining focus, an agent's turn ending, or one of the actions here.
 */

interface Entry {
    repo: GitRepo | null;
    loadedAt: number;
    error?: string;
}

interface GitState {
    repos: Record<string, Entry>;
}

const useGitStore = create<GitState>()(() => ({ repos: {} }));

const reads = singleFlight<string>();

/**
 * Reads `cwd`'s checkout again; one read at a time per folder. With `fresh`,
 * a read already running is followed by another (it may predate a change).
 */
function refresh(cwd: string, fresh = false): Promise<void> {
    return reads(
        cwd,
        () =>
            gitApi
                .repo(cwd)
                .then(
                    (repo): Entry => ({ repo, loadedAt: Date.now() }),
                    (error): Entry => ({
                        repo: useGitStore.getState().repos[cwd]?.repo ?? null,
                        loadedAt: Date.now(),
                        error: errorText(error)
                    })
                )
                .then((entry) => {
                    useGitStore.setState((s) => ({ repos: { ...s.repos, [cwd]: entry } }));
                }),
        fresh
    );
}

const errorText = (error: unknown) => errorMessage(error, "Git failed.");

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
            setError(errorText(e));
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, error, setError, run };
}

/** Older than this, a mounted reader reads again. */
const MAX_AGE = 5_000;

/**
 * `cwd`'s checkout: undefined until first read, null outside a checkout.
 * Re-read while mounted when stale, when the folder changes on disk, on
 * window focus, and when an agent working in that folder goes idle.
 */
export function useGitRepo(cwd: string | null | undefined) {
    const entry = useGitStore((s) => (cwd ? s.repos[cwd] : undefined));
    const busy = useFolderBusy(cwd);

    useTurnEnded(cwd, () => {
        if (cwd) void refresh(cwd);
    });

    useEffect(() => {
        if (!cwd) return;
        const known = useGitStore.getState().repos[cwd];
        if (!known || Date.now() - known.loadedAt > MAX_AGE) void refresh(cwd);
    }, [cwd, busy]);

    useEffect(() => {
        if (!cwd) return;
        return onWindowFocus(() => void refresh(cwd));
    }, [cwd]);

    // A branch switched, a commit made, a file changed (its uncommitted count).
    useFolderWatch(cwd, (change) => {
        if (cwd && touchesTree(change)) void refresh(cwd, true);
    });

    return entry;
}

/**
 * An agent is mid-turn in `cwd` (its folder, or its worktree's), so the
 * branch there shouldn't move under it.
 */
export function useFolderBusy(cwd: string | null | undefined) {
    return useChatsStore(
        (s) =>
            !!cwd && s.chats.some((c) => workDir(c) === cwd && isBusy(s.sessions[c.id]?.status))
    );
}

/**
 * Calls `onEnd` (the latest one) each time an agent's turn in `cwd` ends:
 * the folder goes from busy (`useFolderBusy`) to idle.
 */
export function useTurnEnded(cwd: string | null | undefined, onEnd: () => void) {
    const busy = useFolderBusy(cwd);
    const wasBusy = useRef(busy);
    const latest = useRef(onEnd);
    useEffect(() => {
        latest.current = onEnd;
    });
    useEffect(() => {
        const ended = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (ended) latest.current();
    }, [busy]);
}

/** Each action re-reads the folder afterwards, failed or not. */
async function then<T>(cwd: string, action: Promise<T>): Promise<T> {
    try {
        return await action;
    } finally {
        await refresh(cwd);
    }
}

export const git = {
    refresh,
    switchBranch: (cwd: string, name: string) =>
        then(cwd, gitApi.switchBranch(cwd, name)),
    createBranch: (cwd: string, name: string, from: string) =>
        then(cwd, gitApi.createBranch(cwd, name, from)),
    deleteBranch: (cwd: string, name: string) =>
        then(cwd, gitApi.deleteBranch(cwd, name))
};
