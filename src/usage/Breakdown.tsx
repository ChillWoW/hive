import type { ReactNode } from "react";
import { HarnessIcon } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { HarnessId } from "@/proto";
import { SegmentedControl, Tooltip } from "@/ui";
import {
    formatCount,
    formatHour,
    formatPercent,
    formatTokens,
    formatUsd,
    formatWeekday,
    shortPath
} from "./format";
import type { Breakdown as BreakdownId } from "./store";
import {
    HARNESS_COLOR,
    HARNESS_NAME,
    HARNESS_ORDER,
    costTotal,
    processed,
    valueOf,
    type Summary
} from "./summary";

type Props = {
    summary: Summary;
    metric: "cost" | "tokens";
    hourly: boolean;
    view: BreakdownId;
    onView: (view: BreakdownId) => void;
    stale?: boolean;
};

/** The numbers behind the chart: by model, by bucket (the chart's table view) or by folder. */
export function Breakdown({ summary, metric, hourly, view, onView, stale }: Props) {
    return (
        <section className="flex flex-col gap-2.5">
            <div className="flex items-center gap-3">
                <h3 className="flex-1 text-[12px] font-medium text-dark-100">Breakdown</h3>
                <SegmentedControl
                    size="sm"
                    value={view}
                    onValueChange={(v) => onView(v as BreakdownId)}
                    aria-label="Break down by"
                >
                    <SegmentedControl.Item value="model">Model</SegmentedControl.Item>
                    <SegmentedControl.Item value="day">{hourly ? "Hour" : "Day"}</SegmentedControl.Item>
                    <SegmentedControl.Item value="project">Project</SegmentedControl.Item>
                </SegmentedControl>
            </div>
            <div className={cn("transition-opacity", stale && "opacity-60")}>
                {view === "model" && <ByModel summary={summary} metric={metric} />}
                {view === "day" && <ByBucket summary={summary} metric={metric} hourly={hourly} />}
                {view === "project" && <ByProject summary={summary} metric={metric} />}
            </div>
        </section>
    );
}

const th = "px-2 py-1.5 text-[11px] font-normal text-dark-250 whitespace-nowrap";
const td = "px-2 py-2 whitespace-nowrap tabular-nums";

function Table({ head, children, empty }: { head: ReactNode; children: ReactNode; empty: boolean }) {
    return (
        <div className="overflow-x-auto rounded-md bg-dark-800">
            <table className="w-full border-collapse text-xs">
                <thead>
                    <tr className="text-right">{head}</tr>
                </thead>
                <tbody className="[&>tr]:border-t [&>tr]:border-dark-700">{children}</tbody>
            </table>
            {empty && <p className="px-3 py-6 text-center text-xs text-dark-250">No usage in this period</p>}
        </div>
    );
}

function ByModel({ summary, metric }: { summary: Summary; metric: "cost" | "tokens" }) {
    const rows = [...summary.models].sort(
        (a, b) => valueOf(b, metric) - valueOf(a, metric) || processed(b.tokens) - processed(a.tokens)
    );
    const total = valueOf(summary.all, metric);
    const top = Math.max(...rows.map((r) => valueOf(r, metric)), 0);
    return (
        <Table
            empty={rows.length === 0}
            head={
                <>
                    <th className={cn(th, "w-6 text-right")}>#</th>
                    <th className={cn(th, "text-left")}>Model</th>
                    <th className={th}>Cost</th>
                    <th className={th}>Share</th>
                    <th className={th}>Tokens</th>
                    <th className={th}>Cache hit</th>
                    <th className={th}>Sessions</th>
                </>
            }
        >
            {rows.map((r, i) => {
                const value = valueOf(r, metric);
                const cost = costTotal(r.cost);
                const input = r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite;
                const unpriced = r.unpriced === r.requests && cost === 0;
                return (
                    <tr key={`${r.harness}/${r.model}`} className="text-right text-dark-100">
                        <td className={cn(td, "text-dark-250")}>{i + 1}</td>
                        <td className={cn(td, "w-full max-w-0 text-left")}>
                            <div className="flex min-w-0 items-center gap-2">
                                <HarnessIcon harness={r.harness} className="size-3.5 shrink-0" />
                                <span className="min-w-0 truncate text-dark-50">{r.model}</span>
                            </div>
                            <div className="mt-1.5 ml-5.5 h-0.5 rounded-full bg-dark-700">
                                <div
                                    className="h-full rounded-full"
                                    style={{
                                        width: `${top ? Math.max((value / top) * 100, 1) : 0}%`,
                                        background: HARNESS_COLOR[r.harness]
                                    }}
                                />
                            </div>
                        </td>
                        <td className={cn(td, "text-dark-50")}>
                            {unpriced ? (
                                <Tooltip>
                                    <Tooltip.Trigger render={<span className="text-dark-250 underline decoration-dotted underline-offset-2" />}>
                                        Unpriced
                                    </Tooltip.Trigger>
                                    <Tooltip.Content>
                                        The price table doesn't know this model and the CLI didn't report a cost
                                    </Tooltip.Content>
                                </Tooltip>
                            ) : (
                                formatUsd(cost)
                            )}
                        </td>
                        <td className={cn(td, "text-dark-200")}>{total ? formatPercent(value / total) : "—"}</td>
                        <td className={td}>{formatTokens(processed(r.tokens))}</td>
                        <td className={cn(td, "text-dark-200")}>
                            {input ? formatPercent(r.tokens.cacheRead / input) : "—"}
                        </td>
                        <td className={cn(td, "text-dark-200")}>{formatCount(r.sessions)}</td>
                    </tr>
                );
            })}
        </Table>
    );
}

function ByBucket({
    summary,
    metric,
    hourly
}: {
    summary: Summary;
    metric: "cost" | "tokens";
    hourly: boolean;
}) {
    const fmt = (v: number) => (metric === "cost" ? formatUsd(v) : formatTokens(v));
    const columns = HARNESS_ORDER.filter((h) =>
        summary.buckets.some((b) => (b.by[h]?.[metric] ?? 0) > 0)
    );
    const rows = summary.buckets.filter((b) => b.tokens > 0 || b.cost > 0).reverse();
    return (
        <Table
            empty={rows.length === 0}
            head={
                <>
                    <th className={cn(th, "text-left")}>{hourly ? "Hour" : "Day"}</th>
                    {columns.map((h) => (
                        <th key={h} className={th}>
                            <span className="inline-flex items-center gap-1.5">
                                <span className="size-2 rounded-[2px]" style={{ background: HARNESS_COLOR[h] }} />
                                {HARNESS_NAME[h]}
                            </span>
                        </th>
                    ))}
                    <th className={th}>Total</th>
                    <th className={th}>{metric === "cost" ? "Tokens" : "Cost"}</th>
                </>
            }
        >
            {rows.map((b) => (
                <tr key={b.start} className="text-right text-dark-100">
                    <td className={cn(td, "text-left text-dark-50")}>
                        {hourly ? `${formatWeekday(b.start)}, ${formatHour(b.start)}` : formatWeekday(b.start)}
                    </td>
                    {columns.map((h) => (
                        <td key={h} className={td}>
                            {b.by[h] ? fmt(b.by[h]![metric]) : <span className="text-dark-400">—</span>}
                        </td>
                    ))}
                    <td className={cn(td, "font-medium text-dark-50")}>{fmt(b[metric])}</td>
                    <td className={cn(td, "text-dark-200")}>
                        {metric === "cost" ? formatTokens(b.tokens) : formatUsd(b.cost)}
                    </td>
                </tr>
            ))}
        </Table>
    );
}

function ByProject({ summary, metric }: { summary: Summary; metric: "cost" | "tokens" }) {
    const value = (p: Summary["projects"][number]) => (metric === "cost" ? p.cost : p.tokens);
    const rows = [...summary.projects].sort((a, b) => value(b) - value(a));
    const total = rows.reduce((s, p) => s + value(p), 0);
    return (
        <Table
            empty={rows.length === 0}
            head={
                <>
                    <th className={cn(th, "text-left")}>Folder</th>
                    <th className={th}>Cost</th>
                    <th className={th}>Share</th>
                    <th className={th}>Tokens</th>
                    <th className={th}>Sessions</th>
                </>
            }
        >
            {rows.map((p) => (
                <tr key={p.path} className="text-right text-dark-100">
                    <td className={cn(td, "w-full max-w-0 text-left")}>
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="flex shrink-0 -space-x-1">
                                {p.harnesses.map((h: HarnessId) => (
                                    <HarnessIcon
                                        key={h}
                                        harness={h}
                                        className="size-3.5 rounded-full bg-dark-800 ring-2 ring-dark-800"
                                    />
                                ))}
                            </span>
                            <Tooltip>
                                <Tooltip.Trigger render={<span className="min-w-0 truncate text-dark-50" />}>
                                    {shortPath(p.path)}
                                </Tooltip.Trigger>
                                <Tooltip.Content>{p.path}</Tooltip.Content>
                            </Tooltip>
                        </div>
                    </td>
                    <td className={cn(td, "text-dark-50")}>{formatUsd(p.cost)}</td>
                    <td className={cn(td, "text-dark-200")}>{total ? formatPercent(value(p) / total) : "—"}</td>
                    <td className={td}>{formatTokens(p.tokens)}</td>
                    <td className={cn(td, "text-dark-200")}>{formatCount(p.sessions)}</td>
                </tr>
            ))}
        </Table>
    );
}
