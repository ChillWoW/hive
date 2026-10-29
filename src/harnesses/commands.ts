import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { HarnessCatalog, HarnessId, SlashCommand } from "@/proto";
import { isTauri } from "@/lib/platform";

/** How long a probed list is fresh; the harness caches as long. */
const FRESH_MS = 30_000;

type Probed = { at: number; commands: SlashCommand[] };

/**
 * Each harness's commands and skills per folder, from `list_commands`: what
 * the composer offers before a session reports its own (a Claude probe
 * starts the CLI just for its list, no turn).
 */
const useProbedStore = create<{ probed: Record<string, Probed> }>()(() => ({
    probed: {}
}));

const key = (harness: HarnessId, cwd: string) => `${harness}\n${cwd}`;
const inflight = new Map<string, Promise<void>>();

/** Re-lists `harness`'s commands in `cwd` unless the last list is fresh. */
export function refreshCommands(harness: HarnessId, cwd: string): Promise<void> {
    const k = key(harness, cwd);
    const last = useProbedStore.getState().probed[k];
    if (!isTauri || (last && Date.now() - last.at < FRESH_MS)) return Promise.resolve();
    let pending = inflight.get(k);
    if (!pending) {
        pending = invoke<SlashCommand[]>("list_commands", { harness, cwd })
            .then(
                (commands) =>
                    useProbedStore.setState((s) => ({
                        probed: { ...s.probed, [k]: { at: Date.now(), commands } }
                    })),
                (error: unknown) => console.warn("[harnesses] listing commands failed", error)
            )
            .finally(() => inflight.delete(k));
        inflight.set(k, pending);
    }
    return pending;
}

/**
 * What the composer's `/` and `$` menus list: a live session's own commands,
 * else the harness's in `cwd` (listed on mount and window focus), else the
 * catalog's built-ins.
 */
export function useCommands(
    catalog: HarnessCatalog | undefined,
    cwd: string | null | undefined,
    live: SlashCommand[] | undefined
): SlashCommand[] {
    const harness = catalog?.id;
    const folder = cwd ?? "";
    const probed = useProbedStore((s) =>
        harness ? s.probed[key(harness, folder)]?.commands : undefined
    );

    useEffect(() => {
        if (!harness) return;
        const refresh = () => void refreshCommands(harness, folder);
        refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [harness, folder]);

    if (live?.length) return live;
    if (probed?.length) return probed;
    return catalog?.commands ?? [];
}
