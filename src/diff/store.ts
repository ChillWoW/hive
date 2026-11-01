import { useEffect, useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isBusy, useChatsStore } from "@/chats";
import { gitApi } from "@/git/api";
import { useFolderBusy } from "@/git/store";
import { errorMessage } from "@/lib/errors";
import { touchesTree, useFolderWatch } from "@/lib/folderWatch";
import { singleFlight } from "@/lib/singleFlight";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitDiff } from "@/proto";

/** What the diff tab compares against, as the scope menu offers. */
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
type DiffSource = { cwd: string; base?: string } | { turnOf: string };

/** Each source's diff, by `keyOf`. */
const useDiffStore = create<{ entries: Record<string, Entry> }>()(() => ({
    entries: {}
}));

const keyOf = (source: DiffSource) =>
    "turnOf" in source ? `turn\0${source.turnOf}` : `${source.cwd}\0${source.base ?? ""}`;

const read = (source: DiffSource) =>
    "turnOf" in source ? gitApi.turnDiff(source.turnOf) : gitApi.diff(source.cwd, source.base);

/** One read at a time per source key. */
const readOnce = singleFlight<string>();

/**
 * Reads a diff again; one read at a time per source. With `fresh`, a read
 * already running is followed by another (it may predate a change).
 */
export function refreshDiff(source: DiffSource, fresh = false): Promise<void> {
    const key = keyOf(source);
    return readOnce(key, () => load(key, source), fresh);
}

/** Reads `source` into its entry. */
function load(key: string, source: DiffSource): Promise<void> {
    return read(source)
        .then(
            (diff): Entry => ({ diff, loadedAt: Date.now() }),
            (error): Entry => ({
                // A failed read keeps what was shown, with the reason.
                diff: useDiffStore.getState().entries[key]?.diff,
                error: errorMessage(error, "Git failed."),
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
        });
}

/**
 * `cwd`'s diff (against `base`'s merge base when given), read on mount, as
 * the folder or its git dir changes on disk (a folder watch), and, in case
 * the watch missed something, on window focus and when an agent's turn
 * there starts or ends.
 */
export function useCheckoutDiff(cwd: string | null, base: string | undefined, enabled = true) {
    // Read again when an agent there starts or ends a turn.
    const entry = useDiff(cwd ? { cwd, base } : null, enabled, useFolderBusy(cwd));

    useFolderWatch(enabled ? cwd : null, (change) => {
        if (cwd && touchesTree(change)) void refreshDiff({ cwd, base }, true);
    });

    return entry;
}

/**
 * `source`'s diff, read while `enabled`: at once, on window focus and
 * whenever `when` changes.
 */
function useDiff(source: DiffSource | null, enabled: boolean, when: unknown) {
    const key = source ? keyOf(source) : null;
    const entry = useDiffStore((s) => (key ? s.entries[key] : undefined));
    useEffect(() => {
        if (!source || !enabled) return;
        const refresh = () => void refreshDiff(source);
        refresh();
        return onWindowFocus(refresh);
        // `key` stands for `source`, a new object every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, enabled, when]);
    return entry;
}

/**
 * `chatId`'s latest turn diff for a finished reply's summary: read when
 * `version` changes (a new reply) and on window focus, never polled.
 */
export function useTurnSummary(chatId: string | undefined, version: string) {
    return useDiff(chatId ? { turnOf: chatId } : null, true, version);
}

/**
 * What `chatId`'s latest prompted turn changed in `cwd`'s checkout. A turn
 * read snapshots the whole checkout, so rather than polling it this follows
 * the cheap working-tree read: read again when that changes, when the chat starts or ends a turn,
 * and on window focus.
 */
export function useTurnDiff(cwd: string | null, chatId: string | null, enabled = true) {
    const treePatch = useCheckoutDiff(cwd, undefined, enabled && !!chatId)?.diff?.patch;
    const busy = useChatsStore((s) => isBusy(chatId ? s.sessions[chatId]?.status : undefined));
    // Read again when the chat starts or ends a turn.
    const entry = useDiff(chatId ? { turnOf: chatId } : null, enabled, busy);

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
