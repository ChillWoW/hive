import { useEffect, useRef } from "react";
import { create } from "zustand";
import { useChatsStore } from "@/chats";
import type { GitRepo } from "@/proto";
import { gitApi } from "./api";

/**
 * Each folder's checkout (`GitRepo`, null outside one), shared by the branch
 * picker and the sidebar's chat cards. Read on demand and again when it may
 * have changed: the window regaining focus, an agent's turn ending, or one
 * of the actions here.
 */

interface Entry {
    repo: GitRepo | null;
    loadedAt: number;
    error?: string;
}

interface GitState {
    repos: Record<string, Entry>;
}

export const useGitStore = create<GitState>()(() => ({ repos: {} }));

const inFlight = new Map<string, Promise<void>>();

/** Reads `cwd`'s checkout again; one read at a time per folder. */
function refresh(cwd: string): Promise<void> {
    let request = inFlight.get(cwd);
    if (!request) {
        request = gitApi
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
            })
            .finally(() => inFlight.delete(cwd));
        inFlight.set(cwd, request);
    }
    return request;
}

export function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : "Git failed.";
}

/** Older than this, a mounted reader reads again. */
const MAX_AGE = 5_000;

/**
 * `cwd`'s checkout: undefined until first read, null outside a checkout.
 * Re-read while mounted when stale, on window focus, and when an agent
 * working in that folder goes idle (it may have switched branches).
 */
export function useGitRepo(cwd: string | null | undefined) {
    const entry = useGitStore((s) => (cwd ? s.repos[cwd] : undefined));
    const busy = useFolderBusy(cwd);
    const wasBusy = useRef(busy);

    useEffect(() => {
        const turnEnded = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (!cwd) return;
        const known = useGitStore.getState().repos[cwd];
        if (!known || Date.now() - known.loadedAt > MAX_AGE || turnEnded) void refresh(cwd);
    }, [cwd, busy]);

    useEffect(() => {
        if (!cwd) return;
        const onFocus = () => void refresh(cwd);
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [cwd]);

    return entry;
}

/** An agent is mid-turn in `cwd`, so its branch shouldn't move under it. */
export function useFolderBusy(cwd: string | null | undefined) {
    return useChatsStore((s) =>
        !!cwd &&
        s.chats.some((c) => {
            if (c.cwd !== cwd) return false;
            const status = s.sessions[c.id]?.status;
            return status === "working" || status === "awaitingInput";
        })
    );
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
