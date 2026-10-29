import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useLayoutStore } from "@/stores/useLayoutStore";

type SidePanelProps = {
    label: string;
    /** Shown width; 0 is closed. */
    width: number;
    /** The width a drag of the left edge asks for with the pointer at `x`. */
    widthAt: (x: number) => number;
    onResize: (width: number) => void;
    children?: ReactNode;
};

/**
 * A column right of the conversation, resized by dragging its left edge.
 * Opening and closing slide its width; the content keeps its last open width
 * meanwhile, so it's uncovered rather than reflowed.
 */
export function SidePanel({
    label,
    width,
    widthAt,
    onResize,
    children
}: SidePanelProps) {
    const open = width > 0;
    const [dragging, setDraggingState] = useState(false);
    const setDragging = (on: boolean) => {
        setDraggingState(on);
        useLayoutStore.getState().setResizing(on);
    };
    const [contentWidth, setContentWidth] = useState(width);
    if (open && width !== contentWidth) setContentWidth(width);

    return (
        <aside
            aria-label={label}
            inert={!open}
            style={{ width }}
            className={cn(
                "relative h-full shrink-0 overflow-hidden",
                !dragging && "transition-[width]"
            )}
        >
            <div
                style={{ width: contentWidth }}
                className="flex h-full flex-col border-l border-dark-600 bg-dark-850 pt-9"
            >
                {children}
            </div>
            {open && (
                <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${label.toLowerCase()}`}
                    onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.preventDefault();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDragging(true);
                    }}
                    onPointerMove={(event) => {
                        if (!dragging) return;
                        onResize(widthAt(event.clientX));
                    }}
                    onPointerUp={() => setDragging(false)}
                    onPointerCancel={() => setDragging(false)}
                    className={cn(
                        "absolute top-9 bottom-0 left-0 z-20 w-1.5 cursor-col-resize",
                        "after:absolute after:inset-y-0 after:left-0 after:w-px after:transition-colors",
                        "hover:after:bg-dark-300",
                        dragging && "after:bg-dark-200 hover:after:bg-dark-200"
                    )}
                />
            )}
        </aside>
    );
}
