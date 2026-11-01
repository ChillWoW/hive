import { useEffect } from "react";
import { create } from "zustand";
import type { HarnessCatalog, HarnessId, SlashCommand } from "@/proto";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";
import { singleFlight } from "@/lib/singleFlight";
import { onWindowFocus } from "@/lib/windowFocus";

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
const listing = singleFlight<string>();

/** Re-lists `harness`'s commands in `cwd` unless the last list is fresh. */
function refreshCommands(harness: HarnessId, cwd: string): Promise<void> {
    const k = key(harness, cwd);
    const last = useProbedStore.getState().probed[k];
    if (!isTauri || (last && Date.now() - last.at < FRESH_MS)) return Promise.resolve();
    return listing(k, () =>
        backend<SlashCommand[]>("list_commands", { harness, cwd }).then(
            (commands) =>
                useProbedStore.setState((s) => ({
                    probed: { ...s.probed, [k]: { at: Date.now(), commands } }
                })),
            (error: unknown) => console.warn("[harnesses] listing commands failed", error)
        )
    );
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
        return onWindowFocus(refresh);
    }, [harness, folder]);

    if (live?.length) return live;
    if (probed?.length) return probed;
    return catalog?.commands ?? [];
}
