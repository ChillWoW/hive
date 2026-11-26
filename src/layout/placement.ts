import { useMemo } from "react";
import { settings, useSettingsStore } from "@/features/settings/store";
import { DEFAULT_SETTINGS, type LayoutColumn } from "@/features/settings/types";

/**
 * Where the dock and panels sit, from the `appearance.layout` setting: the
 * window's columns left to right, the dock at one end, the panels on either
 * side of the main column in any order.
 */

/** A column beside the main one. */
export type Panel = Exclude<LayoutColumn, "dock" | "main">;

export const PANELS: readonly Panel[] = ["chats", "tabs", "files"];

export type Side = "left" | "right";

export const DEFAULT_LAYOUT: readonly LayoutColumn[] = DEFAULT_SETTINGS.appearance.layout;

export type Placement = {
    /** Every column, left to right. */
    columns: LayoutColumn[];
    dock: Side;
    /** The panels left of the main column, left to right. */
    left: Panel[];
    /** The panels right of the main column, left to right. */
    right: Panel[];
};

/**
 * Each column once, the dock at an end; mirrors `LayoutColumn::normalize` in
 * `schema.rs`. Duplicates keep their first place; a missing column goes beside
 * the main one on its default side (the dock to its default end); no main
 * column resets the whole layout.
 */
export function normalizeLayout(columns: readonly LayoutColumn[]): LayoutColumn[] {
    const out: LayoutColumn[] = [];
    for (const column of columns) {
        if (DEFAULT_LAYOUT.includes(column) && !out.includes(column)) out.push(column);
    }
    if (!out.includes("main")) return [...DEFAULT_LAYOUT];
    const defaultMain = DEFAULT_LAYOUT.indexOf("main");
    DEFAULT_LAYOUT.forEach((column, at) => {
        if (out.includes(column)) return;
        const leftSide = at < defaultMain;
        const main = out.indexOf("main");
        const index =
            column === "dock" ? (leftSide ? 0 : out.length) : leftSide ? main : main + 1;
        out.splice(index, 0, column);
    });
    const dock = out.indexOf("dock");
    if (dock !== 0 && dock !== out.length - 1) {
        const leftOfMain = dock < out.indexOf("main");
        out.splice(dock, 1);
        if (leftOfMain) out.unshift("dock");
        else out.push("dock");
    }
    return out;
}

const isPanel = (column: LayoutColumn): column is Panel => column !== "dock" && column !== "main";

export function placementOf(layout: readonly LayoutColumn[]): Placement {
    const columns = normalizeLayout(layout);
    const main = columns.indexOf("main");
    return {
        columns,
        dock: columns.indexOf("dock") < main ? "left" : "right",
        left: columns.slice(0, main).filter(isPanel),
        right: columns.slice(main + 1).filter(isPanel)
    };
}

/** Which side of the main column `panel` is on. */
export const sideOf = (placement: Placement, panel: Panel): Side =>
    placement.left.includes(panel) ? "left" : "right";

/** The placement right now, outside React. */
export const getPlacement = () => placementOf(settings.get().appearance.layout);

export function usePlacement(): Placement {
    const layout = useSettingsStore((s) => s.settings.appearance.layout);
    return useMemo(() => placementOf(layout), [layout]);
}

/**
 * `column` moved to sit at `index` of the others (0: leftmost). The dock only
 * goes to an end: whichever is nearer.
 */
export function moveColumn(
    layout: readonly LayoutColumn[],
    column: LayoutColumn,
    index: number
): LayoutColumn[] {
    const rest = layout.filter((c) => c !== column);
    let at = Math.max(0, Math.min(index, rest.length));
    if (column === "dock") at = at <= rest.length / 2 ? 0 : rest.length;
    rest.splice(at, 0, column);
    return normalizeLayout(rest);
}

/** The layout flipped left to right. */
export const mirrorLayout = (layout: readonly LayoutColumn[]) =>
    normalizeLayout([...layout].reverse());
