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
