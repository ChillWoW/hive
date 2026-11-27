import { useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** How far the pointer moves before a press on a tab becomes a drag, in px. */
const DRAG_SLOP = 4;

/**
 * Press-and-drag reordering for a strip's `[role=tab]`s: past `DRAG_SLOP` the
 * pressed tab moves to whichever slot the pointer is over, live. Pointer
 * events, since the webview's HTML drag and drop is the window's file drop on
 * Windows.
 */
export function useTabDrag(scroller: RefObject<HTMLElement | null>, move: (from: number, to: number) => void) {
    return (event: ReactPointerEvent<HTMLElement>, index: number) => {
        if (event.button !== 0) return;
        const target = event.currentTarget;
        const startX = event.clientX;
        let from = index;
        let dragging = false;

        const onMove = (pointer: PointerEvent) => {
            if (!dragging && Math.abs(pointer.clientX - startX) < DRAG_SLOP) return;
            if (!dragging) {
                dragging = true;
                target.setPointerCapture(pointer.pointerId);
            }
            const slots = Array.from(scroller.current?.querySelectorAll<HTMLElement>("[role=tab]") ?? []);
            const to = slots.findIndex((slot) => {
                const rect = slot.getBoundingClientRect();
                return pointer.clientX >= rect.left && pointer.clientX < rect.right;
            });
            if (to >= 0 && to !== from) {
                move(from, to);
                from = to;
            }
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
    };
}

/** The wheel scrolls `scroller` sideways; non-passive so the page doesn't scroll too. */
export function useSidewaysWheel(scroller: RefObject<HTMLElement | null>) {
    useEffect(() => {
        const el = scroller.current;
        if (!el) return;
        const onWheel = (event: WheelEvent) => {
            if (el.scrollWidth <= el.clientWidth || event.deltaX !== 0) return;
            event.preventDefault();
            el.scrollLeft += event.deltaY;
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [scroller]);
}

/**
 * The strip's `[data-tab-active]` tab scrolls into view, and stays there as
 * the strip narrows; again whenever `key` (what's shown, how many tabs) changes.
 */
export function useRevealActive(scroller: RefObject<HTMLElement | null>, key: string) {
    useEffect(() => {
        const root = scroller.current;
        if (!root) return;
        const reveal = () =>
            root
                .querySelector<HTMLElement>("[data-tab-active]")
                ?.scrollIntoView({ block: "nearest", inline: "nearest" });
        reveal();
        const observer = new ResizeObserver(reveal);
        // The tabs too: they can shrink while the strip keeps its width.
        for (const el of [root, ...Array.from(root.children)]) observer.observe(el);
        return () => observer.disconnect();
    }, [scroller, key]);
}
