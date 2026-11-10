import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
    edgeOf,
    getPanelLayout,
    PANEL_WIDTHS,
    useLayoutStore,
    usePanelLayout,
    type Panel
} from "./store";

/**
 * A column beside the main one, as wide as the layout gives it (see
 * `panelLayout`). It closes, or hides for room, by sliding its width to 0;
 * the content keeps its last width meanwhile, so it's uncovered rather than
 * reflowed. Dragging its inner edge resizes it; a double-click there resets
 * it. The top bar overlays its first 36px.
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
    const edge = edgeOf(panel);
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
                edge === "right" && "justify-end",
                !resizing && "transition-[width] duration-200 ease-out"
            )}
        >
            <div
                style={{ width: contentWidth }}
                className={cn(
                    "flex h-full shrink-0 flex-col border-border bg-surface pt-9",
                    edge === "left" ? "border-r" : "border-l"
                )}
            >
                {children}
            </div>
            {open && <ResizeHandle panel={panel} label={label} />}
        </aside>
    );
}

/** The shown width of the panels between `panel` and its window edge. */
const outerWidth = (panel: Panel) => (panel === "right" ? getPanelLayout().widths.files : 0);

/** A panel's inner edge: drag to resize, double-click to reset. */
function ResizeHandle({ panel, label }: { panel: Panel; label: string }) {
    // This edge's own drag; the store's `resizing` is shared by every edge.
    const [dragging, setDragging] = useState(false);
    const { setWidth, setResizing, touch } = useLayoutStore.getState();
    // Where the pointer grabbed, relative to the edge, so the edge doesn't jump to it.
    const grab = useRef(0);
    const edge = edgeOf(panel);

    /** The pointer's distance from the panel's outer side. */
    const reach = (clientX: number) =>
        (edge === "left" ? clientX : window.innerWidth - clientX) - outerWidth(panel);
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
                "absolute top-9 bottom-0 z-20 w-1.5 cursor-col-resize",
                "after:absolute after:inset-y-0 after:w-px after:transition-colors",
                edge === "left" ? "right-0 after:right-0" : "left-0 after:left-0",
                "hover:after:bg-muted/50",
                dragging && "after:bg-muted hover:after:bg-muted"
            )}
        />
    );
}
