import { cn } from "@/lib/cn";
import type { ActivityLine } from "@/transcript";

/**
 * What a live agent is doing, on one muted line: its icon, label and
 * detail ("Run  cargo test"), under a sidebar row's title (the
 * `chats.showActivity` setting).
 */
export function ActivityText({ line, className }: { line: ActivityLine; className?: string }) {
    const { icon: Icon, label, detail } = line;
    return (
        <span
            className={cn(
                "flex min-w-0 items-center gap-1 text-[11px] leading-4 text-dark-250",
                className
            )}
        >
            {Icon && <Icon className="size-3 shrink-0" />}
            <span className="shrink-0 text-dark-200">{label}</span>
            {detail && <span className="min-w-0 truncate">{detail}</span>}
        </span>
    );
}
