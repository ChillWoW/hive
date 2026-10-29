import { useLayoutEffect, useRef, useState } from "react";
import type { HarnessId } from "@/proto";
import { cn } from "@/lib/cn";
import {
    formatHour,
    formatTokens,
    formatTokensTick,
    formatUsd,
    formatUsdTick,
    formatDay,
    formatWeekday
} from "./format";
import { HARNESS_COLOR, HARNESS_NAME, HARNESS_ORDER, type BucketTotals } from "./summary";

const HEIGHT = 196;
const PAD = { top: 8, right: 4, bottom: 22, left: 44 };
const GAP = 2;
const RADIUS = 4;

type Props = {
    buckets: BucketTotals[];
    metric: "cost" | "tokens";
    hourly: boolean;
    /** Harnesses to draw, in stack order (bottom first). */
    harnesses: HarnessId[];
    /** Dims while a newer report loads. */
    stale?: boolean;
};

/**
 * Cost or processed tokens per bucket, stacked by harness: a column per hour
 * or day, ≤24px wide, 2px surface gaps between segments, rounded only at the
 * top. Each column's whole height is its hover / focus target; the tooltip
 * lists every harness at that bucket and the total.
 */
export function UsageChart({ buckets, metric, hourly, harnesses, stale }: Props) {
    const box = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    const [hover, setHover] = useState<number | null>(null);

    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
        observer.observe(el);
        setWidth(el.clientWidth);
        return () => observer.disconnect();
    }, []);

    const order = HARNESS_ORDER.filter((h) => harnesses.includes(h));
    const value = (b: BucketTotals, h?: HarnessId) =>
        h ? (b.by[h]?.[metric] ?? 0) : b[metric];
    const max = Math.max(0, ...buckets.map((b) => value(b)));
    const ticks = niceTicks(max);
    const top = ticks[ticks.length - 1] || 1;

    const plotW = Math.max(0, width - PAD.left - PAD.right);
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const slot = buckets.length ? plotW / buckets.length : 0;
    const barW = Math.max(1, Math.min(24, slot - GAP, slot * 0.72));
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
    const format = metric === "cost" ? formatUsdTick : formatTokensTick;
    const every = labelEvery(buckets.length, plotW, hourly);

    const hovered = hover == null ? null : buckets[hover];

    return (
        <div ref={box} className={cn("relative w-full transition-opacity", stale && "opacity-60")}>
            {width > 0 && (
                <svg
                    width={width}
                    height={HEIGHT}
                    role="img"
                    aria-label={`${metric === "cost" ? "Cost" : "Tokens"} per ${hourly ? "hour" : "day"}`}
                    onPointerLeave={() => setHover(null)}
                    className="block overflow-visible"
                >
                    {ticks.map((t) => (
                        <g key={t}>
                            <line
                                x1={PAD.left}
                                x2={width - PAD.right}
                                y1={y(t)}
                                y2={y(t)}
                                className="stroke-dark-700"
                                strokeWidth={1}
                                shapeRendering="crispEdges"
                            />
                            <text
                                x={PAD.left - 8}
                                y={y(t)}
                                dy="0.32em"
                                textAnchor="end"
                                className="fill-dark-300 text-[10.5px] tabular-nums"
                            >
                                {format(t)}
                            </text>
                        </g>
                    ))}

                    {buckets.map((b, i) => {
                        const x = PAD.left + i * slot + (slot - barW) / 2;
                        let base = y(0);
                        const drawn = order.filter((h) => value(b, h) > 0);
                        return (
                            <g
                                key={b.start}
                                opacity={hover == null || hover === i ? 1 : 0.55}
                                className="transition-opacity duration-100"
                            >
                                {drawn.map((h, j) => {
                                    const v = value(b, h);
                                    const h0 = (v / top) * plotH;
                                    const last = j === drawn.length - 1;
                                    // The gap comes out of the segment above the one below.
                                    const height = Math.max(0, h0 - (j > 0 ? GAP : 0));
                                    const yTop = base - h0;
                                    base = yTop;
                                    if (height < 0.5) return null;
                                    return (
                                        <path
                                            key={h}
                                            d={column(x, yTop, barW, height, last ? RADIUS : 0)}
                                            fill={HARNESS_COLOR[h]}
                                        />
                                    );
                                })}
                                <rect
                                    x={PAD.left + i * slot}
                                    y={PAD.top}
                                    width={slot}
                                    height={plotH}
                                    fill="transparent"
                                    tabIndex={0}
                                    aria-label={`${label(b.start, hourly)}: ${metric === "cost" ? formatUsd(b.cost) : formatTokens(b.tokens)}`}
                                    onPointerEnter={() => setHover(i)}
                                    onFocus={() => setHover(i)}
                                    onBlur={() => setHover(null)}
                                    className="outline-none"
                                />
                                {i % every === 0 && (
                                    <text
                                        x={PAD.left + i * slot + slot / 2}
                                        y={HEIGHT - 6}
                                        textAnchor="middle"
                                        className="pointer-events-none fill-dark-300 text-[10.5px]"
                                    >
                                        {hourly ? formatHour(b.start) : formatDay(b.start)}
                                    </text>
                                )}
                            </g>
                        );
                    })}

                    <line
                        x1={PAD.left}
                        x2={width - PAD.right}
                        y1={y(0)}
                        y2={y(0)}
                        className="stroke-dark-500"
                        strokeWidth={1}
                        shapeRendering="crispEdges"
                    />
                </svg>
            )}

            {hovered && hover != null && (
                <Tip
                    bucket={hovered}
                    metric={metric}
                    hourly={hourly}
                    harnesses={order}
                    left={PAD.left + hover * slot + slot / 2}
                    width={width}
                />
            )}
        </div>
    );
}

function Tip({
    bucket,
    metric,
    hourly,
    harnesses,
    left,
    width
}: {
    bucket: BucketTotals;
    metric: "cost" | "tokens";
    hourly: boolean;
    harnesses: HarnessId[];
    left: number;
    width: number;
}) {
    const fmt = (v: number) => (metric === "cost" ? formatUsd(v, { exact: true }) : formatTokens(v));
    const flip = left > width * 0.62;
    const rows = harnesses.filter((h) => bucket.by[h]);
    return (
        <div
            role="tooltip"
            style={{
                left: flip ? undefined : left + 14,
                right: flip ? width - left + 14 : undefined
            }}
            className="pointer-events-none absolute top-1 z-10 min-w-40 rounded-md border border-dark-600 bg-dark-850 px-2.5 py-2 text-xs shadow-lg shadow-black/40"
        >
            <div className="mb-1.5 text-[11px] text-dark-300">{label(bucket.start, hourly)}</div>
            <div className="flex flex-col gap-1">
                {rows.map((h) => (
                    <div key={h} className="flex items-center gap-2">
                        <span
                            className="h-0.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: HARNESS_COLOR[h] }}
                        />
                        <span className="font-medium tabular-nums text-dark-50">
                            {fmt(bucket.by[h]![metric])}
                        </span>
                        <span className="ml-auto pl-3 text-dark-300">{HARNESS_NAME[h]}</span>
                    </div>
                ))}
                {rows.length === 0 && <span className="text-dark-300">No usage</span>}
                {rows.length > 1 && (
                    <div className="mt-0.5 flex items-center gap-2 border-t border-dark-700 pt-1.5">
                        <span className="w-2.5" />
                        <span className="font-semibold tabular-nums text-dark-50">
                            {fmt(bucket[metric])}
                        </span>
                        <span className="ml-auto pl-3 text-dark-300">Total</span>
                    </div>
                )}
            </div>
        </div>
    );
}

function label(start: number, hourly: boolean) {
    if (!hourly) return formatWeekday(start);
    return `${formatWeekday(start)}, ${formatHour(start)}`;
}

/** A column with its top corners rounded by `r`, square at the baseline. */
function column(x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.min(r, w / 2, h);
    if (rr <= 0) return `M${x},${y}h${w}v${h}h${-w}Z`;
    return (
        `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}` +
        `H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
    );
}

/** 0 and up to four round steps covering `max`. */
function niceTicks(max: number): number[] {
    if (max <= 0) return [0];
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
    const count = Math.ceil(max / step);
    return Array.from({ length: count + 1 }, (_, i) => i * step);
}

/** Every how many buckets an x label fits (~56px apart). */
function labelEvery(count: number, width: number, hourly: boolean) {
    if (count === 0 || width === 0) return 1;
    const fits = Math.max(1, Math.floor(width / 56));
    const step = Math.ceil(count / fits);
    // Days on week boundaries read better; hours in 3s and 6s.
    const nice = hourly ? [1, 2, 3, 4, 6, 12] : [1, 2, 7, 14, 30];
    return nice.find((n) => n >= step) ?? step;
}
