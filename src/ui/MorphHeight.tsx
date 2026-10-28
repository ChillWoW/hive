import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** How long a swap takes; the same feel as the composer's own morph. */
const MORPH_MS = 220;

/**
 * Animates its height when what it shows is swapped (`swapKey` changes),
 * instead of jumping to the new content's size, and fades the new content
 * in. Anchored to the bottom, so a box at the bottom of the window grows and
 * shrinks from its top edge. Between swaps the height follows the content
 * instantly (a growing text field stays snappy) and nothing is clipped, so
 * popovers hanging off the content still show.
 */
export function MorphHeight({
    swapKey,
    children,
    className
}: {
    swapKey: string;
    children: ReactNode;
    className?: string;
}) {
    const frameRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    // Set during render, so the transition is on in the very commit that swaps.
    const [shownKey, setShownKey] = useState(swapKey);
    const [morphing, setMorphing] = useState(false);
    if (shownKey !== swapKey) {
        setShownKey(swapKey);
        setMorphing(true);
    }

    useEffect(() => {
        if (!morphing) return;
        const timer = window.setTimeout(() => setMorphing(false), MORPH_MS);
        return () => window.clearTimeout(timer);
    }, [morphing, shownKey]);

    // The frame's height is written straight from the content's, before
    // paint, so it has something to transition from and never lags a frame.
    useLayoutEffect(() => {
        const frame = frameRef.current;
        const content = contentRef.current;
        if (!frame || !content) return;
        const sync = () => {
            frame.style.height = `${content.offsetHeight}px`;
        };
        sync();
        const observer = new ResizeObserver(sync);
        observer.observe(content);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            ref={frameRef}
            data-morph={morphing || undefined}
            className={cn(
                "flex flex-col justify-end",
                "transition-[height] duration-0 ease-[cubic-bezier(0.22,1,0.36,1)]",
                "data-morph:overflow-hidden data-morph:duration-[220ms] motion-reduce:transition-none",
                className
            )}
        >
            <div ref={contentRef} className="shrink-0">
                <div
                    key={swapKey}
                    className="transition-opacity duration-200 ease-out starting:opacity-0 motion-reduce:transition-none"
                >
                    {children}
                </div>
            </div>
        </div>
    );
}
