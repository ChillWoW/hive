import { useEffect, useEffectEvent, useRef, useState } from "react";
import { gitApi } from "@/features/git/api";
import { useFolderBusy } from "@/features/git/store";
import { errorMessage } from "@/lib/errors";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitChanges } from "@/proto";

/** While an agent works in the folder, its changes are read again this often. */
const BUSY_POLL_MS = 3_000;

export type ChangesState = {
    /** Undefined until first read; null outside a checkout. */
    changes: GitChanges | null | undefined;
    error: string | null;
    loading: boolean;
    refresh: () => void;
};

/**
 * `cwd`'s uncommitted changes, read on mount and again when they may have
 * changed: the window regaining focus, every few seconds while an agent
 * works there and once its turn ends, or a `refresh`.
 */
export function useChanges(cwd: string): ChangesState {
    const [changes, setChanges] = useState<GitChanges | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const busy = useFolderBusy(cwd);
    // The latest read wins; an older one finishing late is dropped.
    const seq = useRef(0);

    const refresh = () => {
        const at = ++seq.current;
        setLoading(true);
        gitApi.changes(cwd).then(
            (next) => {
                if (at !== seq.current) return;
                // The same patch keeps its object, so nothing re-parses.
                setChanges((prev) =>
                    prev && next && prev.patch === next.patch && prev.root === next.root && prev.skipped === next.skipped
                        ? prev
                        : next
                );
                setError(null);
                setLoading(false);
            },
            (e: unknown) => {
                if (at !== seq.current) return;
                setError(errorMessage(e, "Couldn't read the changes."));
                setLoading(false);
            }
        );
    };
    const reread = useEffectEvent(refresh);

    useEffect(() => {
        reread();
        return onWindowFocus(() => reread());
    }, [cwd]);

    const wasBusy = useRef(busy);
    useEffect(() => {
        const ended = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (ended) reread();
        if (!busy) return;
        const timer = setInterval(() => reread(), BUSY_POLL_MS);
        return () => clearInterval(timer);
    }, [busy]);

    return { changes, error, loading, refresh };
}
