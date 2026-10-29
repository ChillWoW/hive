import { cn } from "@/lib/cn";
import { formatPercent } from "./format";

export type Share = { id: string; label: string; value: number; color: string; display: string };

/**
 * One 100% bar split into parts (2px surface gaps, no strokes) with a legend
 * under it: swatch, name, value, share. Parts worth nothing are left out.
 */
export function ShareBar({ title, parts, stale }: { title: string; parts: Share[]; stale?: boolean }) {
    const shown = parts.filter((p) => p.value > 0);
    const total = shown.reduce((s, p) => s + p.value, 0);
    return (
        <section className={cn("flex flex-col gap-2.5 transition-opacity", stale && "opacity-60")}>
            <h3 className="text-[12px] font-medium text-dark-100">{title}</h3>
            <div
                role="img"
                aria-label={shown.map((p) => `${p.label} ${formatPercent(p.value / total)}`).join(", ")}
                className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-sm"
            >
                {total === 0 ? (
                    <div className="h-full w-full bg-dark-700" />
                ) : (
                    shown.map((p) => (
                        <div
                            key={p.id}
                            style={{ flexGrow: p.value, background: p.color }}
                            className="h-full min-w-[2px] basis-0"
                        />
                    ))
                )}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {parts.map((p) => (
                    <div key={p.id} className="flex items-center gap-1.5 text-xs">
                        <span className="size-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
                        <span className="text-dark-200">{p.label}</span>
                        <span className="font-medium tabular-nums text-dark-50">{p.display}</span>
                        <span className="tabular-nums text-dark-300">
                            {total ? formatPercent(p.value / total) : "—"}
                        </span>
                    </div>
                ))}
            </div>
        </section>
    );
}
