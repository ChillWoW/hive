import { useRef } from "react";
import { SettingsButton } from "@/features/settings";
import { cn } from "@/lib/cn";
import { SIDEBAR_DEFAULT_WIDTH, useLayoutStore, useSidebarWidth } from "./store";

/**
 * The left column. It closes by sliding its width to 0; the content keeps its
 * own width meanwhile, so it's uncovered rather than reflowed. Dragging its
 * right edge resizes it; a double-click there resets it. The top bar overlays
 * its first 36px.
 */
export function Sidebar() {
    const open = useLayoutStore((s) => s.sidebarOpen);
    const contentWidth = useLayoutStore((s) => s.sidebarWidth);
    const resizing = useLayoutStore((s) => s.resizing);
    const width = useSidebarWidth();

    return (
        <aside
            aria-label="Sidebar"
            inert={!open}
            style={{ width }}
            className={cn(
                "relative h-full shrink-0 overflow-hidden",
                !resizing && "transition-[width] duration-200 ease-out"
            )}
        >
            <div
                style={{ width: contentWidth }}
                className="flex h-full flex-col border-r border-border bg-surface pt-9"
            >
                <div className="min-h-0 flex-1" />
                <div className="flex shrink-0 flex-col px-2 py-1.5">
                    <SettingsButton />
                </div>
            </div>
            {open && <ResizeHandle />}
        </aside>
    );
}

/** The sidebar's right edge: drag to resize, double-click to reset. */
function ResizeHandle() {
    const resizing = useLayoutStore((s) => s.resizing);
    const { setSidebarWidth, setResizing } = useLayoutStore.getState();
    // Where the pointer grabbed, relative to the edge, so the edge doesn't jump to it.
    const grab = useRef(0);

    const stop = () => setResizing(false);

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                grab.current = event.clientX - useLayoutStore.getState().sidebarWidth;
                setResizing(true);
            }}
            onPointerMove={(event) => {
                if (resizing) setSidebarWidth(event.clientX - grab.current);
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
            className={cn(
                "absolute top-9 right-0 bottom-0 z-20 w-1.5 cursor-col-resize",
                "after:absolute after:inset-y-0 after:right-0 after:w-px after:transition-colors",
                "hover:after:bg-muted/50",
                resizing && "after:bg-muted hover:after:bg-muted"
            )}
        />
    );
}
