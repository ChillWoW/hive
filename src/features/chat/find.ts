import { useCallback, useDeferredValue, useEffect, useRef, useState, type RefObject } from "react";

/** The CSS highlights matches are painted with (`::highlight()` in `src/index.css`). */
const ALL = "chat-find";
const CURRENT = "chat-find-current";

/** Matches past this aren't marked or counted. */
const LIMIT = 5000;

/** How long the transcript has to hold still before it's searched again, in ms. */
const RESCAN_MS = 120;

/** Room kept over a match scrolled to, for the find bar, and under it, in px. */
const REVEAL_TOP = 56;
const REVEAL_BOTTOM = 24;

/** Elements that run on in their parent's line: text either side of their edges can match as one. */
const INLINE = new Set([
    "A", "ABBR", "B", "BDI", "CODE", "DEL", "EM", "I", "KBD", "MARK", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "U"
]);

/**
 * Text as find compares it: lower case, every whitespace a space. The same
 * length as `text`, so a place in one is that place in the other.
 */
export function foldText(text: string): string {
    const lower = text.toLowerCase();
    // A few letters lower-case to more than one: those keep their case.
    return (lower.length === text.length ? lower : text).replace(/\s/g, " ");
}

const blocks = new WeakMap<Element, Element>();

/** The nearest ancestor that isn't inline, by tag. */
function blockOf(element: Element): Element {
    let block = blocks.get(element);
    if (!block) {
        block = element;
        while (INLINE.has(block.tagName) && block.parentElement) block = block.parentElement;
        blocks.set(element, block);
    }
    return block;
}

/**
 * Where `needle` (folded) is in the text shown under `root`, in order. A
 * match may run across elements within a block (a highlighted line of code
 * is many spans), not from one block into the next.
 */
function findMatches(root: HTMLElement, needle: string): StaticRange[] {
    const nodes: Text[] = [];
    const starts: number[] = [];
    const pieces: string[] = [];
    const shown = new Map<Element, boolean>();
    let length = 0;
    let lastBlock: Element | null = null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        const parent = text.parentElement;
        if (!parent || !text.data) continue;
        let visible = shown.get(parent);
        if (visible === undefined) {
            visible = parent.checkVisibility();
            shown.set(parent, visible);
        }
        if (!visible) continue;
        const block = blockOf(parent);
        if (block !== lastBlock) {
            // Folded text has no newline, so nothing matches across this.
            pieces.push("\n");
            length += 1;
            lastBlock = block;
        }
        nodes.push(text);
        starts.push(length);
        pieces.push(foldText(text.data));
        length += text.data.length;
    }

    const haystack = pieces.join("");
    const found: StaticRange[] = [];
    let first = 0;
    for (
        let at = haystack.indexOf(needle);
        at !== -1 && found.length < LIMIT;
        at = haystack.indexOf(needle, at + needle.length)
    ) {
        const end = at + needle.length;
        while (first + 1 < nodes.length && starts[first + 1]! <= at) first++;
        let last = first;
        while (last + 1 < nodes.length && starts[last + 1]! < end) last++;
        found.push(
            new StaticRange({
                startContainer: nodes[first]!,
                startOffset: at - starts[first]!,
                endContainer: nodes[last]!,
                endOffset: end - starts[last]!
            })
        );
    }
    return found;
}

/** `match` as a range that can be measured; null once its text has left the page. */
function liveRange(match: StaticRange): Range | null {
    if (!match.startContainer.isConnected || !match.endContainer.isConnected) return null;
    const range = new Range();
    try {
        range.setStart(match.startContainer, match.startOffset);
        range.setEnd(match.endContainer, match.endOffset);
    } catch {
        return null;
    }
    return range;
}

/** The first match at or under the top of what's on screen, else the last one; -1 without any. */
function firstInView(matches: StaticRange[], scroller: HTMLElement): number {
    const top = scroller.getBoundingClientRect().top;
    let low = 0;
    let high = matches.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        const range = liveRange(matches[mid]!);
        if (range && range.getBoundingClientRect().top < top) low = mid + 1;
        else high = mid;
    }
    return Math.min(low, matches.length - 1);
}

function clearHighlights() {
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
}

export type TranscriptFind = {
    open: boolean;
    query: string;
    /** What's being looked for now (`foldText`), a beat behind the typing; empty while closed. */
    needle: string;
    /** Matches found, at most `LIMIT`. */
    count: number;
    /** Whether there may be more than `count`. */
    capped: boolean;
    /** The current match; -1 without one. */
    index: number;
    inputRef: RefObject<HTMLInputElement | null>;
    /** Opens the bar, or takes the caret back to it. */
    start: () => void;
    close: () => void;
    setQuery: (query: string) => void;
    next: () => void;
    previous: () => void;
};

const NONE = { count: 0, index: -1 };

/**
 * Find in a transcript: marks every place the query is in the text shown
 * under `contentRef` and steps through them, scrolling `scrollerRef`. It
 * searches the page, so text that isn't drawn (a collapsed tool's output)
 * isn't found; the transcript is searched again as it changes. Scrolling to
 * a match clears `pinnedRef`, so a streaming reply doesn't pull it away.
 */
export function useTranscriptFind(
    scrollerRef: RefObject<HTMLElement | null>,
    contentRef: RefObject<HTMLElement | null>,
    pinnedRef: RefObject<boolean>
): TranscriptFind {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const needle = useDeferredValue(open ? foldText(query) : "");
    const [result, setResult] = useState(NONE);
    const inputRef = useRef<HTMLInputElement>(null);
    const matchesRef = useRef<StaticRange[]>([]);
    const indexRef = useRef(-1);
    // What had the keyboard before the bar took it.
    const returnRef = useRef<HTMLElement | null>(null);

    const go = useCallback(
        (index: number, reveal: boolean) => {
            const matches = matchesRef.current;
            const range = matches[index] ? liveRange(matches[index]) : null;
            indexRef.current = matches[index] ? index : -1;
            setResult({ count: matches.length, index: indexRef.current });
            if (!range) {
                CSS.highlights.delete(CURRENT);
                return;
            }
            const current = new Highlight(range);
            current.priority = 1;
            CSS.highlights.set(CURRENT, current);

            const scroller = scrollerRef.current;
            if (!reveal || !scroller) return;
            const rect = range.getBoundingClientRect();
            const view = scroller.getBoundingClientRect();
            if (rect.top >= view.top + REVEAL_TOP && rect.bottom <= view.bottom - REVEAL_BOTTOM) return;
            pinnedRef.current = false;
            scroller.scrollTop += rect.top - view.top - view.height / 3;
        },
        [scrollerRef, pinnedRef]
    );

    useEffect(() => {
        const content = contentRef.current;
        if (!needle || !content) return;

        const scan = (fresh: boolean) => {
            const matches = findMatches(content, needle);
            matchesRef.current = matches;
            CSS.highlights.set(ALL, new Highlight(...matches));
            const scroller = scrollerRef.current;
            if ((fresh || indexRef.current < 0) && scroller) go(firstInView(matches, scroller), fresh);
            else go(Math.min(indexRef.current, matches.length - 1), false);
        };
        scan(true);

        let timer = 0;
        const observer = new MutationObserver(() => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => scan(false), RESCAN_MS);
        });
        observer.observe(content, { childList: true, subtree: true, characterData: true });
        return () => {
            observer.disconnect();
            window.clearTimeout(timer);
            clearHighlights();
            matchesRef.current = [];
            indexRef.current = -1;
        };
    }, [needle, contentRef, scrollerRef, go]);

    const step = (by: number) => {
        const count = matchesRef.current.length;
        if (count) go((indexRef.current + by + count) % count, true);
    };

    const shown = needle ? result : NONE;
    return {
        open,
        query,
        needle,
        count: shown.count,
        capped: shown.count >= LIMIT,
        index: shown.index,
        inputRef,
        start: () => {
            const active = document.activeElement;
            if (!open && active instanceof HTMLElement) returnRef.current = active;
            setOpen(true);
            // Already up: the bar takes the caret itself when it mounts.
            inputRef.current?.select();
        },
        close: () => {
            setOpen(false);
            const back = returnRef.current;
            returnRef.current = null;
            if (back?.isConnected) back.focus();
        },
        setQuery,
        next: () => step(1),
        previous: () => step(-1)
    };
}
