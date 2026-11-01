import { cn } from "@/lib/cn";

/**
 * The trays above the composer (usage warning, goal, queued prompts) share
 * one card, `trayStackClassName`, so stacked ones read as one block, split
 * by hairlines, instead of a step per tray. Hidden while every tray is.
 */
export const trayStackClassName =
    "mx-4 overflow-hidden rounded-t-2xl border border-b-0 border-dark-700 bg-dark-900 empty:hidden";

/** One tray inside the stack. */
export const trayClassName = cn(
    "px-1 pt-1 pb-1.5 not-first:border-t not-first:border-dark-700",
    "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0"
);

/** A tray's header line: icon, title, what it's about, then its buttons. */
export const trayHeaderClassName = "flex h-6 min-w-0 items-center gap-1.5 px-2.5 text-xs";

/** The buttons at a header's end, flush with the tray's edge. */
export const trayActionsClassName = "ml-auto flex shrink-0 items-center gap-0.5 -mr-1.5";

/** A small text button in a tray's header (Resume, Clear, Limits). */
export const trayButtonClassName = cn(
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-dark-200 outline-none",
    "transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
);
