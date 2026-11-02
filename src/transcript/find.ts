/**
 * Find in chat: matches of a query in what the transcript shows, as DOM
 * ranges, painted with the CSS Custom Highlight API (no DOM changes, so the
 * markdown renderer and streaming are left alone). Folded rows aren't in the
 * DOM, so their insides aren't searched.
 */

/** Text under these isn't searched. */
const SKIP = "script, style, textarea, [data-find-skip]";

/** Text in different ones of these never joins into one match. */
const BLOCK =
    "p, li, pre, div, h1, h2, h3, h4, h5, h6, td, th, blockquote, summary, dt, dd, section, article, label";

const SEPARATOR = "\n";

/** Every case-insensitive match of `query` under `root`, in document order. */
export function findRanges(root: HTMLElement, query: string): Range[] {
    const needle = query.toLowerCase();
    if (!needle.trim()) return [];

    const visible = new Map<Element, boolean>();
    const isShown = (el: Element) => {
        let shown = visible.get(el);
        if (shown === undefined) {
            shown = !el.closest(SKIP) && (el.checkVisibility?.() ?? true);
            visible.set(el, shown);
        }
        return shown;
    };

    const nodes: Text[] = [];
    const starts: number[] = [];
    let haystack = "";
    let lastBlock: Element | null = null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        const parent = node.parentElement;
        if (!text || !parent || !isShown(parent)) continue;
        const block = parent.closest(BLOCK);
        if (nodes.length > 0 && block !== lastBlock) haystack += SEPARATOR;
        lastBlock = block;
        const lower = text.toLowerCase();
        nodes.push(node as Text);
        starts.push(haystack.length);
        // Lowercasing that changes the length (rare) would skew the offsets.
        haystack += lower.length === text.length ? lower : text;
    }

    /** The node holding `at` and the offset in it. */
    const locate = (at: number, end: boolean): [Text, number] => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            // An end exactly on a boundary belongs to the node before it.
            if (end ? starts[mid]! < at : starts[mid]! <= at) lo = mid;
            else hi = mid - 1;
        }
        return [nodes[lo]!, at - starts[lo]!];
    };

    const ranges: Range[] = [];
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
        const [startNode, startOffset] = locate(at, false);
        const [endNode, endOffset] = locate(at + needle.length, true);
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, Math.min(endOffset, endNode.length));
        ranges.push(range);
    }
    return ranges;
}

const ALL = "chat-find";
const CURRENT = "chat-find-current";

const supported = () => typeof Highlight !== "undefined" && typeof CSS !== "undefined" && "highlights" in CSS;

/** Paints the matches, `current` brighter on top. */
export function paintMatches(ranges: Range[], current: Range | undefined) {
    if (!supported()) return;
    CSS.highlights.set(ALL, new Highlight(...ranges));
    const now = new Highlight(...(current ? [current] : []));
    now.priority = 1;
    CSS.highlights.set(CURRENT, now);
}

export function clearMatches() {
    if (!supported()) return;
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
}

/** Scrolls `scroller` so `range` sits a third of the way down, unless it's already well in view. */
export function revealRange(scroller: HTMLElement, range: Range) {
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const view = scroller.getBoundingClientRect();
    const margin = 56;
    if (rect.top >= view.top + margin && rect.bottom <= view.bottom - margin) return;
    scroller.scrollTop += rect.top - view.top - view.height / 3;
}
