import { cn } from "@/lib/cn";

/**
 * The square icon-only button the chrome is full of — the top bar's toggles,
 * window controls, panel and modal headers, row actions. One recipe, so a
 * button in one bar hovers, presses and dims exactly like its neighbour in the
 * next. The glyph is the caller's (`size-3.5`, or `size-4` in the top bar).
 */
export const iconButtonClassName = cn(
    "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-dark-200 outline-none",
    "transition-colors duration-150",
    "hover:bg-dark-700 hover:text-dark-50 active:bg-dark-600",
    "focus-visible:bg-dark-700 focus-visible:text-dark-50",
    "data-[popup-open]:bg-dark-700 data-[popup-open]:text-dark-50",
    "disabled:pointer-events-none disabled:opacity-50"
);
