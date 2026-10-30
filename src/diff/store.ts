import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gitApi } from "@/git/api";
import { errorText, useFolderBusy } from "@/git/store";
import type { GitDiff } from "@/proto";

/** What the diff tab compares against, as zeron's scope menu offers. */
export type DiffScope = "workingTree" | "branch";

export const SCOPE_LABELS: Record<DiffScope, string> = {
    workingTree: "Working tree",
    branch: "Branch changes"
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
    /** Null outside a checkout; undefined until the first read. */
    diff?: GitDiff | null;
    error?: string;
    loadedAt: number;
};

/** Each folder's diff, by `cwd` and base ("" for the working tree). */
export const useDiffStore = create<{ entries: Record<string, Entry> }>()(() => ({
    entries: {}
}));

const keyOf = (cwd: string, base?: string) => `${cwd}\0${base ?? ""}`;
const inFlight = new Map<string, Promise<void>>();

/** Reads `cwd`'s diff again; one read at a time per folder and base. */
export function refreshDiff(cwd: string, base?: string): Promise<void> {
    const key = keyOf(cwd, base);
    let request = inFlight.get(key);
    if (!request) {
        request = gitApi
            .diff(cwd, base)
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
    const key = cwd ? keyOf(cwd, base) : null;
    const entry = useDiffStore((s) => (key ? s.entries[key] : undefined));
    const busy = useFolderBusy(cwd);

    // Runs again when an agent there starts or ends a turn, reading it then.
    useEffect(() => {
        if (!cwd || !enabled) return;
        void refreshDiff(cwd, base);
        const onFocus = () => void refreshDiff(cwd, base);
        window.addEventListener("focus", onFocus);
        const timer = window.setInterval(
            () => {
                if (document.hasFocus()) void refreshDiff(cwd, base);
            },
            busy ? BUSY_POLL : IDLE_POLL
        );
        return () => {
            window.removeEventListener("focus", onFocus);
            window.clearInterval(timer);
        };
    }, [cwd, base, busy, enabled]);

    return entry;
}
