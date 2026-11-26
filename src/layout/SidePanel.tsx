import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { getPlacement, sideOf, usePlacement } from "./placement";
import {
    BOX_INSET,
    DOCK_WIDTH,
    getPanelLayout,
    PANEL_WIDTHS,
    useLayoutStore,
    usePanelLayout,
    type Panel
} from "./store";

/**
 * A column beside the main one, on whichever side `appearance.layout` puts it,
 * as wide as the layout gives it (see `panelLayout`). It closes, or hides for
 * room, by sliding its width to 0; the content keeps its last width meanwhile,
 * so it's uncovered rather than reflowed. Dragging its inner edge resizes it;
 * a double-click there resets it. It shares the inset box's colour, set apart
 * by its border.
 */
export function SidePanel({
    panel,
    label,
    children
}: {
    panel: Panel;
    label: string;
    children?: ReactNode;
}) {
    const layout = usePanelLayout();
    const open = layout.visible[panel];
    const width = layout.widths[panel];
    const resizing = useLayoutStore((s) => s.resizing);
    const side = sideOf(usePlacement(), panel);
    // The last shown width, kept while it slides closed.
    const [contentWidth, setContentWidth] = useState(width);
    if (width > 0 && width !== contentWidth) setContentWidth(width);

    return (
        <aside
            aria-label={label}
            inert={!open}
            style={{ width }}
            className={cn(
                "relative flex h-full shrink-0 overflow-hidden",
                side === "right" && "justify-end",
                !resizing && "transition-[width] duration-200 ease-out"
            )}
        >
            <div
                style={{ width: contentWidth }}
                className={cn(
                    "flex h-full shrink-0 flex-col border-border pt-2",
                    side === "left" ? "border-r" : "border-l"
                )}
            >
                {children}
            </div>
            {open && <ResizeHandle panel={panel} label={label} side={side} />}
        </aside>
    );
}

/**
 * The shown width of what's between `panel` and its window edge: the dock or
 * the box's inset, the box's 1px border, and the panels further out.
 */
function outerWidth(panel: Panel) {
    const placement = getPlacement();
    const side = sideOf(placement, panel);
    const row = placement[side];
    const at = row.indexOf(panel);
    const further = side === "left" ? row.slice(0, at) : row.slice(at + 1);
    const { widths } = getPanelLayout();
    const edge = placement.dock === side ? DOCK_WIDTH : BOX_INSET;
    return edge + 1 + further.reduce((sum, p) => sum + widths[p], 0);
}

/** A panel's inner edge: drag to resize, double-click to reset. */
function ResizeHandle({ panel, label, side }: { panel: Panel; label: string; side: "left" | "right" }) {
    // This edge's own drag; the store's `resizing` is shared by every edge.
    const [dragging, setDragging] = useState(false);
    const { setWidth, setResizing, touch } = useLayoutStore.getState();
    // Where the pointer grabbed, relative to the edge, so the edge doesn't jump to it.
    const grab = useRef(0);

    /** The pointer's distance from the panel's outer side. */
    const reach = (clientX: number) =>
        (side === "left" ? clientX : window.innerWidth - clientX) - outerWidth(panel);
    const drag = (on: boolean) => {
        setDragging(on);
        setResizing(on);
    };
    const stop = () => drag(false);

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${label.toLowerCase()}`}
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                grab.current = reach(event.clientX) - getPanelLayout().widths[panel];
                // The panel being dragged keeps its width; the others give way.
                touch(panel);
                drag(true);
            }}
            onPointerMove={(event) => {
                if (!dragging) return;
                const max = getPanelLayout().dragMax[panel];
                setWidth(panel, Math.min(reach(event.clientX) - grab.current, max));
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onDoubleClick={() => setWidth(panel, PANEL_WIDTHS[panel].default)}
            className={cn(
                "absolute inset-y-0 z-20 w-1.5 cursor-col-resize",
                "after:absolute after:inset-y-0 after:w-px after:transition-colors",
                side === "left" ? "right-0 after:right-0" : "left-0 after:left-0",
                "hover:after:bg-muted/50",
                dragging && "after:bg-muted hover:after:bg-muted"
            )}
        />
    );
}
