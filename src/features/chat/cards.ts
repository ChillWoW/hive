import { cn } from "@/lib/cn";

/**
 * The frame of the cards above the composer (approvals, questions, plans,
 * secrets): the composer's own, with a quiet heading line inside.
 */
export const cardClassName = cn(
    "mb-2 flex w-full flex-col gap-3 rounded-[22px] border border-border bg-surface p-4 outline-none",
    "transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0"
);
