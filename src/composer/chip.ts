import { cn } from "@/lib/cn";

/**
 * The pickers in and under the composer: a small rounded trigger, the
 * dropdown it opens, its rows and footer buttons.
 */

/** A picker inside the composer box, beside the send button. */
export const pickerTriggerClassName = cn(
    "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5",
    "text-sm text-dark-200 outline-none select-none transition-colors duration-150",
    "hover:bg-dark-700 hover:text-dark-50",
    "data-[popup-open]:bg-dark-700 data-[popup-open]:text-dark-50"
);

/** A chip under the composer. */
export const chipClassName = cn(
    "inline-flex h-6 min-w-0 max-w-64 items-center gap-1.5 rounded-md px-2",
    "text-xs text-dark-200 outline-none select-none transition-colors duration-150"
);

export const chipTriggerClassName = cn(
    chipClassName,
    "hover:bg-dark-700 hover:text-dark-50",
    "data-[popup-open]:bg-dark-700 data-[popup-open]:text-dark-50"
);

/** The dropdown; the width is the caller's. */
export const popupClassName = cn(
    // The overlay layer it mounts into is click-through.
    "pointer-events-auto flex max-w-[var(--available-width)] flex-col overflow-hidden outline-none",
    "rounded-md border border-dark-600 bg-dark-850 text-dark-50 shadow-lg shadow-black/40",
    "origin-[var(--transform-origin)] transition-[opacity,scale] duration-150 ease-out",
    "data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
    "data-[ending-style]:scale-95 data-[ending-style]:opacity-0"
);

/** A list row: icon or blank, label, check. */
export const rowClassName = cn(
    "grid cursor-pointer grid-cols-[0.875rem_1fr_1rem] items-center gap-x-2 rounded-sm px-2 py-1.5 outline-none select-none",
    "text-xs text-dark-100 data-[highlighted]:bg-dark-700",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

export const footerButtonClassName = cn(
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-dark-100 outline-none select-none",
    "hover:bg-dark-700 disabled:pointer-events-none disabled:opacity-50"
);

export const searchInputClassName =
    "h-8 w-full bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-300";
