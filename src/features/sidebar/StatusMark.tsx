import { cn } from "@/lib/cn";
import { STATUS, type ChatStatus } from "./status";

/** The status dot, centred in a 16px slot. */
export function StatusMark({ status, className }: { status: ChatStatus; className?: string }) {
    const { label, className: tone } = STATUS[status];
    return (
        <span className={cn("flex w-4 shrink-0 justify-center", className)}>
            <span
                role={label ? "img" : undefined}
                aria-label={label || undefined}
                className={cn("size-1.5 rounded-full", tone)}
            />
        </span>
    );
}
