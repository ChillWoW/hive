import { cn } from "@/lib/cn";

/** A chat or draft row's main button; `active` while it's what the main pane shows. */
export function rowClassName(active: boolean) {
    return cn(
        "flex h-7 w-full items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-xs outline-none",
        "transition-colors duration-100",
        "focus-visible:ring-1 focus-visible:ring-muted/50",
        active ? "bg-hover text-text" : "text-text/85 hover:bg-raised hover:text-text"
    );
}

/** A small button over a row's right end, shown while the row is hovered (add the group's `group-hover`). */
export const ROW_ACTION = cn(
    "absolute top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center",
    "rounded-sm text-muted outline-none",
    "transition-[color,background-color,opacity] duration-100",
    "hover:bg-border hover:text-text focus-visible:opacity-100",
    "opacity-0"
);

export const warn = (error: unknown) => console.warn("[sidebar]", error);
