import { cn } from "@/lib/cn";
import type { DiffRow, FileDiff } from "./diff";

/** Rows past this many are counted rather than drawn. */
const MAX_ROWS = 400;

/** Soft emerald and red washes, an accent bar, a marker (Tailwind's emerald-400, red-400). */
const TONE: Record<DiffRow["kind"], { row: string; accent: string; marker: string; no: string }> = {
    add: {
        row: "bg-[#34d399]/[0.07]",
        accent: "bg-[#34d399]/55",
        marker: "text-[#34d399]",
        no: "text-[#34d399]/90"
    },
    del: {
        row: "bg-[#f87171]/[0.07]",
        accent: "bg-[#f87171]/55",
        marker: "text-[#f87171]",
        no: "text-[#f87171]/90"
    },
    context: { row: "", accent: "", marker: "", no: "text-muted/70" }
};

/**
 * A file change (or a file as read), unified: line numbers when known, a
 * `+`/`−` marker, the code unwrapped and scrolling sideways. Scrolls past
 * 20rem.
 */
export function DiffView({ file, className }: { file: FileDiff; className?: string }) {
    const gutter = file.maxLine ? Math.max(String(file.maxLine).length * 7 + 14, 36) : 0;
    const marked = file.additions + file.deletions > 0;
    const hidden = Math.max(0, file.rows.length - MAX_ROWS);
    return (
        <div className={cn("max-h-80 overflow-auto rounded-md bg-surface py-1 font-mono text-xs", className)}>
            <div className="min-w-fit">
                {file.rows.slice(0, MAX_ROWS).map((row, i) => {
                    const tone = TONE[row.kind];
                    const numbers = file.oneSide ? [row.newNo] : [row.oldNo, row.newNo];
                    return (
                        <div key={i} className={cn("relative flex min-h-5 leading-5", tone.row)}>
                            {/* The numbers stay put while the code scrolls sideways. */}
                            <div className="sticky left-0 z-[1] flex shrink-0 bg-surface">
                                <span className={cn("absolute inset-0", tone.row)} />
                                {tone.accent && (
                                    <span className={cn("absolute inset-y-0 left-0 w-[3px]", tone.accent)} />
                                )}
                                {gutter > 0 &&
                                    numbers.map((no, n) => (
                                        <span
                                            key={n}
                                            style={{ width: gutter }}
                                            className={cn("relative pr-2 text-right tabular-nums select-none", tone.no)}
                                        >
                                            {no ?? ""}
                                        </span>
                                    ))}
                                {marked && (
                                    <span className={cn("relative w-5 text-center select-none", tone.marker)}>
                                        {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
                                    </span>
                                )}
                            </div>
                            <span className={cn("pr-3 whitespace-pre text-text/85", !marked && !gutter && "pl-3")}>
                                {row.text || " "}
                            </span>
                        </div>
                    );
                })}
                {hidden > 0 && (
                    <div className="px-3 pt-0.5 font-sans text-muted/85">
                        {hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"}
                    </div>
                )}
            </div>
        </div>
    );
}
