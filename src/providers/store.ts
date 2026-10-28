import { create } from "zustand";
import type { HarnessId, ProviderStatus } from "@/proto";
import { refreshCatalogs } from "@/harnesses";
import { isNewer, latestRelease, providersApi } from "./api";

/** A long-running action on a provider's CLI. */
export type ProviderAction = "installing" | "updating" | "signing-out";

export type ProviderEntry = {
    status?: ProviderStatus;
    /** A probe is in flight. */
    probing: boolean;
    /** Newest release on the CLI's channel; null when the check failed. */
    latest?: string | null;
    latestCheckedAt?: number;
    action?: ProviderAction;
    /** The last action's failure, shown until the next one. */
    error?: string;
};

type ProvidersState = {
    entries: Partial<Record<HarnessId, ProviderEntry>>;
};

export const useProvidersStore = create<ProvidersState>()(() => ({
    entries: {}
}));

const EMPTY: ProviderEntry = { probing: false };

export function useProvider(harness: HarnessId): ProviderEntry {
    return useProvidersStore((s) => s.entries[harness] ?? EMPTY);
}

function patch(harness: HarnessId, next: Partial<ProviderEntry>) {
    useProvidersStore.setState((s) => ({
        entries: {
            ...s.entries,
            [harness]: { ...(s.entries[harness] ?? EMPTY), ...next }
        }
    }));
}

const entry = (harness: HarnessId) =>
    useProvidersStore.getState().entries[harness] ?? EMPTY;

/** The release check hits npm; once per this long unless forced. */
const LATEST_TTL = 10 * 60 * 1000;
const probes = new Map<HarnessId, Promise<void>>();

/**
 * Probes `harness`'s CLI and, when it's installed, looks up its newest
 * release. Concurrent calls share one probe.
 */
export function refreshProvider(
    harness: HarnessId,
    { force = false }: { force?: boolean } = {}
): Promise<void> {
    const running = probes.get(harness);
    if (running) return running;

    const probe = (async () => {
        patch(harness, { probing: true });
        try {
            const status = await providersApi.status(harness);
            patch(harness, { status });
            await checkLatest(harness, status, force);
        } catch (error) {
            console.warn("[providers] status failed", harness, error);
        } finally {
            patch(harness, { probing: false });
            probes.delete(harness);
        }
    })();
    probes.set(harness, probe);
    return probe;
}

async function checkLatest(harness: HarnessId, status: ProviderStatus, force: boolean) {
    const { latestCheckedAt } = entry(harness);
    if (!status.installed || !status.updateChannel) return;
    if (!force && latestCheckedAt && Date.now() - latestCheckedAt < LATEST_TTL) return;
    try {
        const latest = await latestRelease(harness, status.updateChannel);
        patch(harness, { latest, latestCheckedAt: Date.now() });
    } catch (error) {
        console.warn("[providers] release check failed", harness, error);
        patch(harness, { latest: null, latestCheckedAt: Date.now() });
    }
}

/** A newer release than the installed one, if one is known. */
export function availableUpdate(provider: ProviderEntry): string | undefined {
    const { status, latest } = provider;
    if (!status?.version || !latest) return undefined;
    return isNewer(latest, status.version) ? latest : undefined;
}

/** Runs `action`, then re-probes; the catalog's `installed` may have changed too. */
async function act(
    harness: HarnessId,
    action: ProviderAction,
    run: () => Promise<void>
): Promise<void> {
    if (entry(harness).action) return;
    patch(harness, { action, error: undefined });
    try {
        await run();
    } catch (error) {
        patch(harness, { error: error instanceof Error ? error.message : String(error) });
    } finally {
        patch(harness, { action: undefined });
        await afterChange(harness);
    }
}

/** Re-reads everything a CLI change can touch. */
export async function afterChange(harness: HarnessId): Promise<void> {
    await Promise.all([refreshProvider(harness, { force: true }), refreshCatalogs()]);
}

export const providers = {
    install: (harness: HarnessId) =>
        act(harness, "installing", () => providersApi.install(harness)),
    update: (harness: HarnessId) =>
        act(harness, "updating", () => providersApi.update(harness)),
    signOut: (harness: HarnessId) =>
        act(harness, "signing-out", () => providersApi.signOut(harness)),
    clearError: (harness: HarnessId) => patch(harness, { error: undefined })
};
