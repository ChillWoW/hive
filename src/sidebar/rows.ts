import { cn } from "@/lib/cn";

/** A chat or draft row's main button; `active` while it's what the main pane shows. */
export function rowClassName(active: boolean) {
    return cn(
        "flex h-7 w-full items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-xs outline-none",
        "transition-colors duration-100",
        "focus-visible:ring-1 focus-visible:ring-dark-400",
        active ? "bg-dark-700 text-dark-50" : "text-dark-100 hover:bg-dark-800 hover:text-dark-50"
    );
}

/** A small button over a row's right end, shown while the row is hovered (add the group's `group-hover`). */
export const ROW_ACTION = cn(
    "absolute top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center",
    "rounded-sm text-dark-200 outline-none",
    "transition-[color,background-color,opacity] duration-100",
    "hover:bg-dark-600 hover:text-dark-50 focus-visible:opacity-100",
    "opacity-0"
);

export const warn = (error: unknown) => console.warn("[sidebar]", error);
