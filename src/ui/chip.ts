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

export const footerButtonClassName = cn(
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-dark-100 outline-none select-none",
    "hover:bg-dark-700 disabled:pointer-events-none disabled:opacity-50"
);

/*
 * The card pickers (folder, branch): the dropdown (`popupClassName`), rows
 * with their detail shown while highlighted, a footer, menus beside a row.
 */

/** The search on top of a card, edge to edge. */
export const cardSearchClassName =
    "flex shrink-0 items-center gap-2 border-b border-dark-600 px-2.5";

export const cardListClassName =
    "hide-scrollbar flex max-h-72 flex-col overflow-y-auto overscroll-contain p-1 empty:hidden";

export const cardRowClassName = cn(
    "group/row flex min-h-7 shrink-0 cursor-pointer items-center gap-2 rounded-sm py-1 pr-1 pl-2 outline-none select-none",
    "text-xs text-dark-100 data-[highlighted]:bg-dark-700",
    "data-[disabled]:cursor-default data-[disabled]:opacity-50"
);

/** What a row says about itself, after its name: only while it's highlighted. */
export const cardRowDetailClassName =
    "hidden min-w-0 truncate text-[11px] text-dark-250 group-data-[highlighted]/row:block";

/** The footer under a card's list. */
export const cardFooterClassName =
    "flex flex-col border-t border-dark-600 p-1 empty:hidden";

export const cardFooterButtonClassName = cn(
    footerButtonClassName,
    "text-left data-[highlighted]:bg-dark-700 data-[popup-open]:bg-dark-700",
    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
);

/** A row's "⋯" menu (or a footer row's choices), beside it. */
export const sideMenuClassName = "w-48 min-w-0";

export const sideMenuItemClassName = "whitespace-nowrap [&_svg]:shrink-0";

/**
 * A row's "⋯" button: in place of the row's meta (time, check) while the
 * row is highlighted or hovered, or its menu is open.
 */
export const rowMenuTriggerClassName = cn(
    "pointer-events-auto hidden size-5 shrink-0 items-center justify-center rounded-sm text-dark-250 outline-none",
    "transition-colors duration-100 hover:bg-dark-600 hover:text-dark-50",
    "group-hover/row:inline-flex group-data-[highlighted]/row:inline-flex",
    "data-[popup-open]:inline-flex data-[popup-open]:bg-dark-600 data-[popup-open]:text-dark-50"
);

/** The row's meta, which the "⋯" button takes the place of. */
export const rowMetaClassName =
    "flex h-5 min-w-5 shrink-0 items-center justify-center group-hover/row:hidden group-data-[highlighted]/row:hidden";

export const searchInputClassName =
    "h-8 w-full bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-250";
