/**
 * The classes of a line in a tool group (`ToolGroup`): a small muted icon, a
 * quiet verb, a brighter target.
 */

export const panelTransition =
    "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0";

/** A line in a group: its icon, then words. */
export const lineClassName = "group/item flex h-[26px] w-full compact:h-[22px] min-w-0 items-center gap-2 text-left text-[13px]";

/** What a line opens onto, under its words (past the 14px icon and its gap). */
export const lineBodyClassName = "pl-[22px]";

/** A line's verb: quiet, a step brighter on hover. */
export const verbClassName = "shrink-0 text-muted/85 transition-colors group-hover/item:text-muted";

/** What the verb acted on: the line's bright part. */
export const targetClassName = "min-w-0 truncate text-muted transition-colors group-hover/item:text-text/80";

/** A soft block under a line: output, a thought, a list. */
export const blockClassName = "mt-0.5 mb-2 overflow-x-auto rounded-lg bg-surface px-3 py-2";
