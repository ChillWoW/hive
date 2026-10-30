import { useEffect, useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useChatsStore } from "@/chats";
import { gitApi } from "@/git/api";
import { errorText, useFolderBusy } from "@/git/store";
import type { GitDiff } from "@/proto";

/** What the diff tab compares against, as zeron's scope menu offers. */
export type DiffScope = "workingTree" | "branch" | "turn";

export const SCOPE_LABELS: Record<DiffScope, string> = {
    workingTree: "Working tree",
    branch: "Branch changes",
    turn: "Latest turn"
};

type Prefs = {
    scope: DiffScope;
    /** Two columns (old | new) rather than one. */
    split: boolean;
    wrap: boolean;
    /** The branch each checkout's branch changes are compared with, by root. */
    bases: Record<string, string>;
    setScope: (scope: DiffScope) => void;
    toggleSplit: () => void;
    toggleWrap: () => void;
    setBase: (root: string, base: string) => void;
};

/** The diff tab's choices, persisted as `hive.diff`. */
export const useDiffPrefs = create<Prefs>()(
    persist(
        (set) => ({
            scope: "workingTree",
            split: false,
            wrap: false,
            bases: {},
            setScope: (scope) => set({ scope }),
            toggleSplit: () => set((s) => ({ split: !s.split })),
            toggleWrap: () => set((s) => ({ wrap: !s.wrap })),
            setBase: (root, base) => set((s) => ({ bases: { ...s.bases, [root]: base } }))
        }),
        {
            name: "hive.diff",
            partialize: ({ scope, split, wrap, bases }) => ({ scope, split, wrap, bases })
        }
    )
);

type Entry = {
    /** Null outside a checkout (or, for a turn, before one); undefined until the first read. */
    diff?: GitDiff | null;
    error?: string;
    loadedAt: number;
};

/** What a diff is read from: a folder (against `base`'s merge base when given) or a chat's latest turn. */
export type DiffSource = { cwd: string; base?: string } | { turnOf: string };

/** Each source's diff, by `keyOf`. */
export const useDiffStore = create<{ entries: Record<string, Entry> }>()(() => ({
    entries: {}
}));

const keyOf = (source: DiffSource) =>
    "turnOf" in source ? `turn\0${source.turnOf}` : `${source.cwd}\0${source.base ?? ""}`;
const inFlight = new Map<string, Promise<void>>();

const read = (source: DiffSource) =>
    "turnOf" in source ? gitApi.turnDiff(source.turnOf) : gitApi.diff(source.cwd, source.base);

/** Reads a diff again; one read at a time per source. */
export function refreshDiff(source: DiffSource): Promise<void> {
    const key = keyOf(source);
    let request = inFlight.get(key);
    if (!request) {
        request = read(source)
            .then(
                (diff): Entry => ({ diff, loadedAt: Date.now() }),
                (error): Entry => ({
                    // A failed read keeps what was shown, with the reason.
                    diff: useDiffStore.getState().entries[key]?.diff,
                    error: errorText(error),
                    loadedAt: Date.now()
                })
            )
            .then((entry) => {
                const previous = useDiffStore.getState().entries[key];
                // The same patch again: keep the old object, so nothing re-renders.
                const same =
                    previous &&
                    previous.error === entry.error &&
                    previous.diff?.patch === entry.diff?.patch &&
                    previous.diff?.branch === entry.diff?.branch &&
                    previous.diff?.mergeBase === entry.diff?.mergeBase &&
                    previous.diff?.truncated === entry.diff?.truncated &&
                    (previous.diff === null) === (entry.diff === null);
                useDiffStore.setState((s) => ({
                    entries: {
                        ...s.entries,
                        [key]: same ? { ...previous, loadedAt: entry.loadedAt } : entry
                    }
                }));
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, request);
    }
    return request;
}

/** How often a shown diff is read again: faster while an agent works there. */
const IDLE_POLL = 5_000;
const BUSY_POLL = 2_000;

/**
 * `cwd`'s diff (against `base`'s merge base when given). Zeron watches the
 * checkout; this reads it on mount, on window focus, when an agent's turn
 * there ends, and every few seconds while the window has focus.
 */
export function useCheckoutDiff(cwd: string | null, base: string | undefined, enabled = true) {
    const key = cwd ? keyOf({ cwd, base }) : null;
    const entry = useDiffStore((s) => (key ? s.entries[key] : undefined));
    const busy = useFolderBusy(cwd);

    // Runs again when an agent there starts or ends a turn, reading it then.
    useEffect(() => {
        if (!cwd || !enabled) return;
        const refresh = () => void refreshDiff({ cwd, base });
        refresh();
        window.addEventListener("focus", refresh);
        const timer = window.setInterval(
            () => {
                if (document.hasFocus()) refresh();
            },
            busy ? BUSY_POLL : IDLE_POLL
        );
        return () => {
            window.removeEventListener("focus", refresh);
            window.clearInterval(timer);
        };
    }, [cwd, base, busy, enabled]);

    return entry;
}

/**
 * What `chatId`'s latest prompted turn changed in `cwd`'s checkout. A turn
 * read snapshots the whole checkout, so rather than polling it this follows
 * the cheap working-tree read (as zeron refetches when the tree's checksum
 * moves): read again when that changes, when the chat starts or ends a turn,
 * and on window focus.
 */
export function useTurnDiff(cwd: string | null, chatId: string | null, enabled = true) {
    const key = chatId ? keyOf({ turnOf: chatId }) : null;
    const entry = useDiffStore((s) => (key ? s.entries[key] : undefined));
    const treePatch = useCheckoutDiff(cwd, undefined, enabled && !!chatId)?.diff?.patch;
    const status = useChatsStore((s) => (chatId ? s.sessions[chatId]?.status : undefined));
    const busy = status === "working" || status === "awaitingInput";

    // Runs again when the chat starts or ends a turn, reading it then.
    useEffect(() => {
        if (!chatId || !enabled) return;
        const refresh = () => void refreshDiff({ turnOf: chatId });
        refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [chatId, enabled, busy]);

    // The working tree moved: so may the turn. Not its first read.
    const lastTree = useRef(treePatch);
    useEffect(() => {
        const previous = lastTree.current;
        lastTree.current = treePatch;
        if (!chatId || !enabled || previous === undefined || previous === treePatch) return;
        void refreshDiff({ turnOf: chatId });
    }, [chatId, enabled, treePatch]);

    return entry;
}
