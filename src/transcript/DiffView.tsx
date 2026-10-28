import { cn } from "@/lib/cn";
import type { DiffLine } from "./diff";

/** A line diff: removals red, additions green, context dim. Scrolls past 20rem. */
export function DiffView({ lines, className }: { lines: DiffLine[]; className?: string }) {
    return (
        <div
            className={cn(
                "max-h-80 overflow-auto rounded-md bg-dark-850 py-1.5 font-mono text-xs leading-[18px]",
                className
            )}
        >
            {lines.map((line, i) => (
                <div
                    key={i}
                    className={cn(
                        "flex min-w-max px-3 whitespace-pre",
                        line.kind === "add" && "bg-success/10 text-success",
                        line.kind === "del" && "bg-danger/10 text-danger",
                        line.kind === "same" && "text-dark-250"
                    )}
                >
                    <span className="w-4 shrink-0 select-none opacity-60">
                        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                    </span>
                    {line.text || " "}
                </div>
            ))}
        </div>
    );
}
