import { useLayoutStore } from "@/layout/store";
import { browserApi, type Viewport } from "./api";

/**
 * A browser tab is a native webview laid over the page, not part of it. This
 * keeps it over its frame: it follows the frame as the layout moves, and
 * gives way whenever the page needs the room. A native view draws above
 * everything the page draws and isn't clipped by it, so while a menu or a
 * dialog overlaps the frame, or a panel is sliding or being resized, the
 * webview hides and a still picture of it stands in.
 */

/** A still picture of the tab, where it was in its frame. */
export type Still = { url: string | null; left: number; top: number; width: number; height: number };

type Box = { left: number; top: number; width: number; height: number };

/** What the frame calls for right now. */
type Want =
    | { mode: "hidden" }
    | { mode: "still" }
    | { mode: "live"; key: string; box: Box; pageWidth: number | null };

/** Where the webview goes in `frame`: all of it, or a fixed page size centred and scaled down to fit. */
function boxIn(frame: Box, viewport: Viewport | null): { box: Box; pageWidth: number | null } {
    if (!viewport) return { box: frame, pageWidth: null };
    const scale = Math.min(1, frame.width / viewport.width, frame.height / viewport.height);
    const width = Math.max(1, Math.floor(viewport.width * scale));
    const height = Math.max(1, Math.floor(viewport.height * scale));
    return {
        box: {
            left: frame.left + Math.floor((frame.width - width) / 2),
            top: frame.top + Math.floor((frame.height - height) / 2),
            width,
            height
        },
        pageWidth: viewport.width
    };
}

/** The ancestors that clip `element`: the panel it slides in, mostly. */
function clippers(element: HTMLElement): HTMLElement[] {
    const found: HTMLElement[] = [];
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(node);
        if (overflowX !== "visible" || overflowY !== "visible") found.push(node);
    }
    return found;
}

/** How much of `box` its clipping ancestors and the window leave showing. */
function shownPart(box: Box, clips: HTMLElement[]): Box {
    let left = Math.max(box.left, 0);
    let top = Math.max(box.top, 0);
    let right = Math.min(box.left + box.width, window.innerWidth);
    let bottom = Math.min(box.top + box.height, window.innerHeight);
    for (const clip of clips) {
        const rect = clip.getBoundingClientRect();
        left = Math.max(left, rect.left);
        top = Math.max(top, rect.top);
        right = Math.min(right, rect.right);
        bottom = Math.min(bottom, rect.bottom);
    }
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Each tab's backend calls, one after another. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Makes a call about tab `id` once the ones before it have answered, so
 * they take effect in the order they were made: a view going away hides
 * its tab, and the view taking over must not have its placement undone by
 * that hide arriving late.
 */
function inOrder<T>(id: string, call: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? Promise.resolve()).then(call, call);
    chains.set(
        id,
        next.catch(() => {})
    );
    return next;
}

const overlaps = (a: Box, b: DOMRect) =>
    a.left < b.right && a.left + a.width > b.left && a.top < b.bottom && a.top + a.height > b.top;

/**
 * Whether something drawn outside the app's root (a menu, a dialog, a
 * tooltip, a toast: all portalled to `<body>`) overlaps `box`.
 */
function covered(box: Box, root: Element | null): boolean {
    for (const layer of Array.from(document.body.children)) {
        if (layer === root || !(layer instanceof HTMLElement)) continue;
        if (layer.tagName === "SCRIPT" || layer.tagName === "STYLE") continue;
        if (overlapsAny(layer, box, 0)) return true;
    }
    return false;
}

function overlapsAny(element: HTMLElement, box: Box, depth: number): boolean {
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true })) {
        return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && overlaps(box, rect)) return true;
    // Positioned descendants can sit outside a zero-sized wrapper.
    if (depth >= 4) return false;
    for (const child of Array.from(element.children)) {
        if (child instanceof HTMLElement && overlapsAny(child, box, depth + 1)) return true;
    }
    return false;
}

/**
 * Keeps tab `id`'s webview over `frame` until the returned function is
 * called. `viewport` gives the page size it's shown at (null: the frame's),
 * `onStill` the picture to draw in the frame while the webview is away.
 */
export function trackFrame(
    id: string,
    frame: HTMLElement,
    viewport: () => Viewport | null,
    onStill: (still: Still | null) => void
): () => void {
    const root = document.getElementById("root");
    const clips = clippers(frame);
    let want: Want = { mode: "hidden" };
    /** What the backend was last told. */
    let applied: Want = { mode: "hidden" };
    /** The calls bringing it to `want`, while any are in flight. */
    let running: Promise<void> | null = null;
    let stopped = false;
    let stillUrl: string | null = null;
    let raf = 0;

    const setStill = (still: Still | null) => {
        if (stillUrl && stillUrl !== still?.url) URL.revokeObjectURL(stillUrl);
        stillUrl = still?.url ?? null;
        if (!stopped) onStill(still);
    };

    const same = (a: Want, b: Want) => a.mode === b.mode && (a.mode !== "live" || a.key === (b as typeof a).key);

    /** Brings the backend to `want`, one call at a time; `want` may move meanwhile. */
    const reconcile = async () => {
        try {
            while (!stopped && !same(applied, want)) {
                const next = want;
                if (next.mode === "live") {
                    const dpr = window.devicePixelRatio || 1;
                    const at = {
                        x: Math.round(next.box.left * dpr),
                        y: Math.round(next.box.top * dpr),
                        width: Math.round(next.box.width * dpr),
                        height: Math.round(next.box.height * dpr),
                        pageWidth: next.pageWidth
                    };
                    await inOrder(id, () => browserApi.place(id, at));
                    // The picture stays under it until it has painted.
                    if (applied.mode !== "live") window.setTimeout(() => want.mode === "live" && setStill(null), 90);
                } else if (next.mode === "still") {
                    if (applied.mode === "live") {
                        const frameBox = frame.getBoundingClientRect();
                        const at = applied.box;
                        const bytes = await inOrder(id, () => browserApi.freeze(id));
                        setStill({
                            url: bytes.byteLength ? URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) : null,
                            left: at.left - frameBox.left,
                            top: at.top - frameBox.top,
                            width: at.width,
                            height: at.height
                        });
                    } else {
                        await inOrder(id, () => browserApi.hide(id));
                    }
                } else {
                    await inOrder(id, () => browserApi.hide(id));
                    setStill(null);
                }
                applied = next;
            }
        } catch {
            // The tab closed under us; its view unmounts next.
        }
    };

    const tick = () => {
        raf = requestAnimationFrame(tick);
        const rect = frame.getBoundingClientRect();
        const frameBox: Box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        const shown = shownPart(frameBox, clips);
        if (shown.width < 1 || shown.height < 1) {
            want = { mode: "hidden" };
        } else {
            const { resizing, sliding } = useLayoutStore.getState();
            const clipped = shown.width < frameBox.width - 1 || shown.height < frameBox.height - 1;
            if (clipped || resizing || sliding || covered(frameBox, root)) {
                want = { mode: "still" };
            } else {
                const { box, pageWidth } = boxIn(frameBox, viewport());
                const key = [box.left, box.top, box.width, box.height, pageWidth, window.devicePixelRatio]
                    .map((n) => (typeof n === "number" ? Math.round(n * 100) : n))
                    .join(",");
                want = { mode: "live", key, box, pageWidth };
            }
        }
        if (!running && !same(applied, want)) {
            running = reconcile().finally(() => {
                running = null;
            });
        }
    };
    raf = requestAnimationFrame(tick);

    return () => {
        stopped = true;
        cancelAnimationFrame(raf);
        if (stillUrl) URL.revokeObjectURL(stillUrl);
        void inOrder(id, () => browserApi.hide(id)).catch(() => {});
    };
}
