import { useEffect } from "react";
import { create } from "zustand";
import type { WorkspaceEntry } from "@/proto";
import { listFiles } from "./api";

/** How long a folder's listing is fresh. */
const FRESH_MS = 15_000;

type Listing = { at: number; entries: WorkspaceEntry[] };

/** Each folder's last listing, shared by every composer showing it. */
const useFilesStore = create<{ listings: Record<string, Listing> }>()(() => ({
    listings: {}
}));

const inflight = new Map<string, Promise<void>>();

/** Re-lists `cwd` unless its last listing is fresh. */
export function refreshFiles(cwd: string): Promise<void> {
    const last = useFilesStore.getState().listings[cwd];
    if (last && Date.now() - last.at < FRESH_MS) return Promise.resolve();
    let pending = inflight.get(cwd);
    if (!pending) {
        pending = listFiles(cwd)
            .then(
                (entries) =>
                    useFilesStore.setState((s) => ({
                        listings: { ...s.listings, [cwd]: { at: Date.now(), entries } }
                    })),
                (error: unknown) => console.warn("[files] listing failed", error)
            )
            .finally(() => inflight.delete(cwd));
        inflight.set(cwd, pending);
    }
    return pending;
}

/**
 * `cwd`'s files and folders, re-listed while `active` whenever the last
 * listing went stale (and on window focus); undefined until the first
 * listing arrives. The last listing stays shown while a new one loads.
 */
export function useWorkspaceFiles(
    cwd: string | null | undefined,
    active: boolean
): WorkspaceEntry[] | undefined {
    const entries = useFilesStore((s) => (cwd ? s.listings[cwd]?.entries : undefined));

    useEffect(() => {
        if (!cwd || !active) return;
        const refresh = () => void refreshFiles(cwd);
        refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [cwd, active]);

    return entries;
}
