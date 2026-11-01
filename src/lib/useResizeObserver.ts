import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Calls `onResize` with `ref`'s element once it's mounted (before paint) and
 * whenever its size changes. `onResize` may change every render; the latest
 * one runs.
 */
export function useResizeObserver<T extends Element>(
    ref: RefObject<T | null>,
    onResize: (el: T, entry?: ResizeObserverEntry) => void
): void {
    const latest = useRef(onResize);
    useLayoutEffect(() => {
        latest.current = onResize;
    });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        latest.current(el);
        const observer = new ResizeObserver(([entry]) => latest.current(el, entry));
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
}
