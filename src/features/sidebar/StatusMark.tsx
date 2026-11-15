import { cn } from "@/lib/cn";
import { DotMatrixSpinner } from "@/ui";
import { STATUS, type ChatStatus } from "./status";

/** The status mark, centred in a 16px slot: a dot, or a dot matrix while working. */
export function StatusMark({ status }: { status: ChatStatus }) {
    const { label, className } = STATUS[status];
    return (
        <span className="flex w-4 shrink-0 justify-center">
            {status === "working" ? (
                <DotMatrixSpinner label={label} className={cn("size-2.5", className)} />
            ) : (
                <span
                    role={label ? "img" : undefined}
                    aria-label={label || undefined}
                    className={cn("size-1.5 rounded-full", className)}
                />
            )}
        </span>
    );
}
