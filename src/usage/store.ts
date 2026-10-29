import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { HarnessId, UsageQuery, UsageReport } from "@/proto";
import { usageApi } from "./api";

export type Period = "24h" | "7d" | "30d" | "90d";
export type Metric = "cost" | "tokens" | "limits";
export type Breakdown = "model" | "day" | "project";

export const PERIODS: { id: Period; label: string; days: number }[] = [
    { id: "24h", label: "24h", days: 1 },
    { id: "7d", label: "7d", days: 7 },
    { id: "30d", label: "30d", days: 30 },
    { id: "90d", label: "90d", days: 90 }
];

type UsageState = {
    isOpen: boolean;
    period: Period;
    metric: Metric;
    breakdown: Breakdown;
    /** Harnesses filtered out of the totals, chart and tables. */
    hidden: HarnessId[];
    /** The last report and the query it answers (kept while the next loads). */
    report?: UsageReport;
    query?: UsageQuery;
    loading: boolean;
    error?: string;
    setOpen: (open: boolean) => void;
    toggle: () => void;
    setPeriod: (period: Period) => void;
    setMetric: (metric: Metric) => void;
    setBreakdown: (breakdown: Breakdown) => void;
    toggleHidden: (harness: HarnessId) => void;
};

export const useUsageStore = create<UsageState>()(
    persist(
        (set) => ({
            isOpen: false,
            period: "30d",
            metric: "cost",
            breakdown: "model",
            hidden: [],
            loading: false,
            setOpen: (isOpen) => set({ isOpen }),
            toggle: () => set((s) => ({ isOpen: !s.isOpen })),
            setPeriod: (period) => set({ period }),
            setMetric: (metric) => set({ metric }),
            setBreakdown: (breakdown) => set({ breakdown }),
            toggleHidden: (harness) =>
                set((s) => ({
                    hidden: s.hidden.includes(harness)
                        ? s.hidden.filter((h) => h !== harness)
                        : [...s.hidden, harness]
                }))
        }),
        {
            name: "hive.usage",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({
                period: s.period,
                metric: s.metric,
                breakdown: s.breakdown,
                hidden: s.hidden
            })
        }
    )
);

const HOUR = 3_600_000;

/**
 * The period as bucket starts: the last 24 hours by the hour, else local
 * days (today included), built from calendar dates so DST days come out
 * 23 or 25 hours long. Ends at the current bucket's end, so the same period
 * asks the same question until the next bucket starts.
 */
export function periodQuery(period: Period, now = new Date()): UsageQuery {
    if (period === "24h") {
        const current = new Date(now);
        current.setMinutes(0, 0, 0);
        const start = current.getTime();
        return {
            buckets: Array.from({ length: 24 }, (_, i) => start - (23 - i) * HOUR),
            until: start + HOUR,
            refreshPrices: false
        };
    }
    const days = PERIODS.find((p) => p.id === period)!.days;
    const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
    return {
        buckets: Array.from({ length: days }, (_, i) =>
            new Date(y, m, d - (days - 1 - i)).getTime()
        ),
        until: new Date(y, m, d + 1).getTime(),
        refreshPrices: false
    };
}

let seq = 0;

/** Reads the open period's report; `refresh` also fetches prices again. */
export async function loadUsage({ refresh = false }: { refresh?: boolean } = {}) {
    const query = { ...periodQuery(useUsageStore.getState().period), refreshPrices: refresh };
    const mine = ++seq;
    useUsageStore.setState({ loading: true });
    try {
        const report = await usageApi.report(query);
        if (mine !== seq) return;
        useUsageStore.setState({ report, query, loading: false, error: undefined });
    } catch (error) {
        if (mine !== seq) return;
        console.warn("[usage] report failed", error);
        useUsageStore.setState({
            loading: false,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
