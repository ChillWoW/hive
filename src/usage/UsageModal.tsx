import { useEffect, useMemo } from "react";
import { ArrowClockwiseIcon, InfoIcon, XIcon } from "@phosphor-icons/react";
import { HarnessIcon } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { UsageReport } from "@/proto";
import { DotMatrixSpinner, iconButtonClassName, Modal, SegmentedControl, Tooltip } from "@/ui";
import { Breakdown } from "./Breakdown";
import { formatAgo, formatCount, formatPercent, formatTokens, formatUsd } from "./format";
import { Limits } from "./Limits";
import { ShareBar, type Share } from "./ShareBar";
import { loadUsage, PERIODS, useUsageStore, type Metric, type Period } from "./store";
import {
    HARNESS_COLOR,
    HARNESS_NAME,
    processed,
    summarize,
    valueOf,
    type Summary
} from "./summary";
import { UsageChart } from "./UsageChart";

/** Token types, in reading order; colours validated as a set on the dark surface. */
const TYPE_COLOR = {
    input: "#9085e9",
    cacheRead: "#c98500",
    cacheWrite: "#d55181",
    output: "#008300",
    other: "#696969"
};

/**
 * Tokens and estimated cost across every agent CLI on this machine, read
 * from their own history (so work outside Hive counts too), as in t3code's
 * usage page. Opened from the sidebar, the usage ring's card, or Mod+U.
 */
export function UsageModal() {
    const isOpen = useUsageStore((s) => s.isOpen);
    const setOpen = useUsageStore((s) => s.setOpen);
    const period = useUsageStore((s) => s.period);
    const metric = useUsageStore((s) => s.metric);
    const setPeriod = useUsageStore((s) => s.setPeriod);
    const setMetric = useUsageStore((s) => s.setMetric);
    const loading = useUsageStore((s) => s.loading);

    // Read on open, on a new period, and when the window comes back.
    useEffect(() => {
        if (!isOpen) return;
        void loadUsage();
        const onFocus = () => void loadUsage();
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [isOpen, period]);

    return (
        <Modal
            open={isOpen}
            onOpenChange={setOpen}
            showClose={false}
            className="flex h-[min(46rem,calc(100%-3rem))] w-[calc(100%-3rem)] max-w-5xl overflow-hidden p-0"
            bodyClassName="flex h-full min-h-0 w-full flex-col"
        >
            <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-dark-700 py-3 pr-3 pl-5">
                <h2 className="mr-auto text-base font-semibold text-dark-50">Usage</h2>
                <SegmentedControl
                    size="sm"
                    value={metric}
                    onValueChange={(v) => setMetric(v as Metric)}
                    aria-label="Show"
                >
                    <SegmentedControl.Item value="cost">Cost</SegmentedControl.Item>
                    <SegmentedControl.Item value="tokens">Tokens</SegmentedControl.Item>
                    <SegmentedControl.Item value="limits">Limits</SegmentedControl.Item>
                </SegmentedControl>
                {metric !== "limits" && (
                    <>
                        <SegmentedControl
                            size="sm"
                            value={period}
                            onValueChange={(v) => setPeriod(v as Period)}
                            aria-label="Period"
                        >
                            {PERIODS.map((p) => (
                                <SegmentedControl.Item key={p.id} value={p.id}>
                                    {p.label}
                                </SegmentedControl.Item>
                            ))}
                        </SegmentedControl>
                        <Tooltip>
                            <Tooltip.Trigger
                                render={
                                    <button
                                        type="button"
                                        aria-label="Refresh usage and prices"
                                        disabled={loading}
                                        onClick={() => void loadUsage({ refresh: true })}
                                        className={iconButtonClassName}
                                    />
                                }
                            >
                                <ArrowClockwiseIcon className={cn("size-3.5", loading && "animate-spin")} />
                            </Tooltip.Trigger>
                            <Tooltip.Content>Refresh usage and prices</Tooltip.Content>
                        </Tooltip>
                    </>
                )}
                <Modal.Close aria-label="Close usage" className={iconButtonClassName}>
                    <XIcon className="size-4" />
                </Modal.Close>
            </header>

            <div className="@container min-h-0 flex-1 overflow-y-auto px-5 py-5">
                {metric === "limits" ? <Limits /> : <Overview metric={metric} />}
            </div>

            {metric !== "limits" && <Footer />}
        </Modal>
    );
}

function Overview({ metric }: { metric: "cost" | "tokens" }) {
    const report = useUsageStore((s) => s.report);
    const query = useUsageStore((s) => s.query);
    const hidden = useUsageStore((s) => s.hidden);
    const toggleHidden = useUsageStore((s) => s.toggleHidden);
    const breakdown = useUsageStore((s) => s.breakdown);
    const setBreakdown = useUsageStore((s) => s.setBreakdown);
    const loading = useUsageStore((s) => s.loading);
    const error = useUsageStore((s) => s.error);

    const summary = useMemo(
        () => (report && query ? summarize(report, query, hidden) : undefined),
        [report, query, hidden]
    );

    if (!summary || !query) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-dark-250">
                {error ? (
                    <>
                        <p className="max-w-sm text-center text-danger">{error}</p>
                        <button
                            type="button"
                            onClick={() => void loadUsage()}
                            className="rounded-md bg-dark-700 px-2.5 py-1 text-dark-50 hover:bg-dark-600"
                        >
                            Try again
                        </button>
                    </>
                ) : (
                    <>
                        <DotMatrixSpinner />
                        Reading agent history…
                    </>
                )}
            </div>
        );
    }

    const hourly = query.buckets.length > 1 && query.buckets[1]! - query.buckets[0]! <= 3_600_000;
    const stale = loading;
    const shownHarnesses = summary.harnesses.map((h) => h.harness).filter((h) => !hidden.includes(h));

    return (
        <div className="flex flex-col gap-7">
            <div className="grid gap-6 @3xl:grid-cols-[16rem_minmax(0,1fr)]">
                <Hero summary={summary} metric={metric} hidden={hidden} onToggle={toggleHidden} stale={stale} />
                <section className="flex min-w-0 flex-col gap-2">
                    <h3 className="text-[12px] font-medium text-dark-100">
                        {metric === "cost" ? "Cost" : "Processed tokens"} per {hourly ? "hour" : "day"}
                    </h3>
                    <UsageChart
                        buckets={summary.buckets}
                        metric={metric}
                        hourly={hourly}
                        harnesses={shownHarnesses}
                        stale={stale}
                    />
                </section>
            </div>

            <Stats summary={summary} metric={metric} stale={stale} />

            <ShareBar
                title={metric === "cost" ? "Cost by type" : "Tokens by type"}
                parts={metric === "cost" ? costShares(summary) : tokenShares(summary)}
                stale={stale}
            />

            <Breakdown
                summary={summary}
                metric={metric}
                hourly={hourly}
                view={breakdown}
                onView={setBreakdown}
                stale={stale}
            />
        </div>
    );
}

function Hero({
    summary,
    metric,
    hidden,
    onToggle,
    stale
}: {
    summary: Summary;
    metric: "cost" | "tokens";
    hidden: string[];
    onToggle: (h: Summary["harnesses"][number]["harness"]) => void;
    stale: boolean;
}) {
    const total = valueOf(summary.all, metric);
    const unpriced = summary.all.unpriced;
    const shownTotal = summary.harnesses
        .filter((h) => !hidden.includes(h.harness))
        .reduce((s, h) => s + valueOf(h, metric), 0);
    return (
        <section className={cn("flex min-w-0 flex-col gap-4 transition-opacity", stale && "opacity-60")}>
            <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1 text-xs text-dark-250">
                    {metric === "cost" ? "Estimated cost" : "Processed tokens"}
                    {metric === "cost" && (
                        <Tooltip>
                            <Tooltip.Trigger
                                render={<span aria-label="About this estimate" className="text-dark-250 hover:text-dark-100" />}
                            >
                                <InfoIcon className="size-3.5" />
                            </Tooltip.Trigger>
                            <Tooltip.Content className="max-w-64 font-normal">
                                What these tokens would cost at pay-as-you-go API prices. On a
                                subscription you pay a flat fee instead.
                                {unpriced > 0 &&
                                    ` ${formatCount(unpriced)} requests have no price and aren't counted.`}
                            </Tooltip.Content>
                        </Tooltip>
                    )}
                </span>
                <span className="text-[40px] leading-none font-semibold tracking-tight text-dark-50">
                    {metric === "cost" ? formatUsd(total) : formatTokens(total)}
                </span>
                <span className="text-xs text-dark-250">
                    {formatCount(summary.all.sessions)} sessions · {formatCount(summary.all.requests)} requests
                    {metric === "cost" && unpriced > 0 && ` · ${formatCount(unpriced)} unpriced`}
                </span>
            </div>

            <div className="flex flex-col">
                {summary.harnesses.map((h) => {
                    const off = hidden.includes(h.harness);
                    const value = valueOf(h, metric);
                    return (
                        <button
                            key={h.harness}
                            type="button"
                            aria-pressed={!off}
                            onClick={() => onToggle(h.harness)}
                            className={cn(
                                "group -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-dark-800",
                                off && "opacity-45"
                            )}
                        >
                            <span
                                className="size-2.5 shrink-0 rounded-[2px] border-2"
                                style={{
                                    background: off ? "transparent" : HARNESS_COLOR[h.harness],
                                    borderColor: HARNESS_COLOR[h.harness]
                                }}
                            />
                            <HarnessIcon harness={h.harness} className="size-3.5 shrink-0" />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-xs text-dark-50">{HARNESS_NAME[h.harness]}</span>
                                <span className="truncate text-[11px] text-dark-250">
                                    {formatCount(h.sessions)} sessions
                                </span>
                            </span>
                            <span className="flex flex-col items-end">
                                <span className="text-xs font-medium tabular-nums text-dark-50">
                                    {metric === "cost" ? formatUsd(value) : formatTokens(value)}
                                </span>
                                <span className="text-[11px] tabular-nums text-dark-250">
                                    {off ? "Hidden" : shownTotal ? formatPercent(value / shownTotal) : "—"}
                                </span>
                            </span>
                        </button>
                    );
                })}
                {summary.harnesses.length === 0 && (
                    <p className="text-xs text-dark-250">No agent usage in this period.</p>
                )}
            </div>
        </section>
    );
}

function Stats({ summary, metric, stale }: { summary: Summary; metric: "cost" | "tokens"; stale: boolean }) {
    const t = summary.all.tokens;
    const input = t.input + t.cacheRead + t.cacheWrite;
    const tiles = [
        // The other metric than the headline's.
        metric === "cost"
            ? { label: "Processed tokens", value: formatTokens(processed(t)) }
            : {
                  label: "Estimated cost",
                  value: formatUsd(valueOf(summary.all, "cost")),
                  note: "at API prices"
              },
        {
            label: "Cache read",
            value: formatTokens(t.cacheRead),
            note: input ? `${formatPercent(t.cacheRead / input)} of input` : undefined
        },
        { label: "Fresh input", value: formatTokens(t.input + t.cacheWrite), note: `${formatTokens(t.cacheWrite)} cached` },
        {
            label: "Output",
            value: formatTokens(t.output),
            note: t.reasoning ? `${formatTokens(t.reasoning)} reasoning` : undefined
        },
        {
            label: "Cache savings",
            value: formatUsd(summary.all.cost.savings),
            note: summary.all.cost.fastPremium > 0
                ? `Fast mode added ${formatUsd(summary.all.cost.fastPremium)}`
                : "vs. paying full input price"
        }
    ];
    return (
        <div
            className={cn(
                "grid grid-cols-2 gap-px overflow-hidden rounded-md bg-dark-700 transition-opacity @xl:grid-cols-3 @3xl:grid-cols-5",
                stale && "opacity-60"
            )}
        >
            {tiles.map((tile) => (
                <div key={tile.label} className="flex flex-col gap-1 bg-dark-800 px-3.5 py-3">
                    <span className="text-[11px] text-dark-250">{tile.label}</span>
                    <span className="text-lg leading-tight font-semibold text-dark-50">{tile.value}</span>
                    <span className="min-h-4 truncate text-[11px] text-dark-250">{tile.note}</span>
                </div>
            ))}
        </div>
    );
}

function tokenShares(summary: Summary): Share[] {
    const t = summary.all.tokens;
    return [
        { id: "input", label: "Input", value: t.input, color: TYPE_COLOR.input, display: formatTokens(t.input) },
        { id: "cacheRead", label: "Cache read", value: t.cacheRead, color: TYPE_COLOR.cacheRead, display: formatTokens(t.cacheRead) },
        { id: "cacheWrite", label: "Cache write", value: t.cacheWrite, color: TYPE_COLOR.cacheWrite, display: formatTokens(t.cacheWrite) },
        { id: "output", label: "Output", value: t.output, color: TYPE_COLOR.output, display: formatTokens(t.output) }
    ];
}

function costShares(summary: Summary): Share[] {
    const c = summary.all.cost;
    const parts: Share[] = [
        { id: "input", label: "Input", value: c.input, color: TYPE_COLOR.input, display: formatUsd(c.input) },
        { id: "cacheRead", label: "Cache read", value: c.cacheRead, color: TYPE_COLOR.cacheRead, display: formatUsd(c.cacheRead) },
        { id: "cacheWrite", label: "Cache write", value: c.cacheWrite, color: TYPE_COLOR.cacheWrite, display: formatUsd(c.cacheWrite) },
        { id: "output", label: "Output", value: c.output, color: TYPE_COLOR.output, display: formatUsd(c.output) }
    ];
    if (c.other > 0) {
        parts.push({ id: "other", label: "Reported, unsplit", value: c.other, color: TYPE_COLOR.other, display: formatUsd(c.other) });
    }
    return parts;
}

function Footer() {
    const report = useUsageStore((s) => s.report);
    if (!report) return null;
    return (
        <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-dark-700 px-5 py-2 text-[11px] text-dark-250">
            {report.sources.map((s) => (
                <SourceNote key={s.harness} source={s} />
            ))}
            <span className="ml-auto">
                <PricingNote pricing={report.pricing} /> · read {formatAgo(report.readAt)}
            </span>
        </footer>
    );
}

function SourceNote({ source }: { source: UsageReport["sources"][number] }) {
    const text =
        source.status === "missing"
            ? "not used here"
            : source.status === "failed"
              ? "couldn't be read"
              : `${formatCount(source.files)} ${source.files === 1 ? "file" : "files"}`;
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <span
                        className={cn(
                            "inline-flex items-center gap-1.5",
                            (source.status === "failed" || source.status === "partial") && "text-warning"
                        )}
                    />
                }
            >
                <HarnessIcon harness={source.harness} className="size-3" />
                {text}
            </Tooltip.Trigger>
            <Tooltip.Content className="max-w-80 font-normal break-all">
                {source.error ?? source.path ?? HARNESS_NAME[source.harness]}
            </Tooltip.Content>
        </Tooltip>
    );
}

function PricingNote({ pricing }: { pricing: UsageReport["pricing"] }) {
    if (pricing.status === "unavailable") {
        return <span className="text-warning">No price table: only costs the CLIs report count</span>;
    }
    return (
        <span>
            Prices from LiteLLM{pricing.fetchedAt ? `, ${formatAgo(pricing.fetchedAt)}` : ""}
        </span>
    );
}
