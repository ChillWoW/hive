import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
    getSidebarWidth,
    isSidebarOpen,
    MAIN_MIN_WIDTH,
    SIDEBAR_WIDTHS,
    useLayoutStore,
    useSidebarContentWidth,
    useSidebarOpen,
    useSidebarWidth,
    type Side
} from "./store";

const other = (side: Side): Side => (side === "left" ? "right" : "left");

/**
 * A column at one side of the main one. It closes by sliding its width to 0;
 * the content keeps its own width meanwhile, so it's uncovered rather than
 * reflowed. Dragging its inner edge resizes it; a double-click there resets
 * it. The top bar overlays its first 36px.
 */
export function SidePanel({
    side,
    label,
    children
}: {
    side: Side;
    label: string;
    children?: ReactNode;
}) {
    const open = useSidebarOpen(side);
    const contentWidth = useSidebarContentWidth(side);
    const resizing = useLayoutStore((s) => s.resizing);
    const width = useSidebarWidth(side);

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
                    "flex h-full shrink-0 flex-col border-border bg-surface pt-9",
                    side === "left" ? "border-r" : "border-l"
                )}
            >
                {children}
            </div>
            {open && <ResizeHandle side={side} label={label} />}
        </aside>
    );
}

/** A panel's inner edge: drag to resize, double-click to reset. */
function ResizeHandle({ side, label }: { side: Side; label: string }) {
    // This edge's own drag; the store's `resizing` is shared by both edges.
    const [dragging, setDragging] = useState(false);
    const { setWidth, setResizing } = useLayoutStore.getState();
    // Where the pointer grabbed, relative to the edge, so the edge doesn't jump to it.
    const grab = useRef(0);

    /** The pointer's distance from the panel's outer (window) edge. */
    const reach = (clientX: number) => (side === "left" ? clientX : window.innerWidth - clientX);
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
                grab.current = reach(event.clientX) - getSidebarWidth(side);
                drag(true);
            }}
            onPointerMove={(event) => {
                if (!dragging) return;
                const opposite = isSidebarOpen(other(side)) ? getSidebarWidth(other(side)) : 0;
                const room = window.innerWidth - opposite - MAIN_MIN_WIDTH;
                setWidth(side, Math.min(reach(event.clientX) - grab.current, room));
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onDoubleClick={() => setWidth(side, SIDEBAR_WIDTHS[side].default)}
            className={cn(
                "absolute top-9 bottom-0 z-20 w-1.5 cursor-col-resize",
                "after:absolute after:inset-y-0 after:w-px after:transition-colors",
                side === "left" ? "right-0 after:right-0" : "left-0 after:left-0",
                "hover:after:bg-muted/50",
                dragging && "after:bg-muted hover:after:bg-muted"
            )}
        />
    );
}
