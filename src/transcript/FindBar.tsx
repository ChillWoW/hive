import { type RefObject, useEffect, useRef, useState } from "react";
import { CaretDownIcon, CaretUpIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { IconButton } from "@/ui";
import { clearMatches, findRanges, paintMatches, revealRange } from "./find";

type FindBarProps = {
    /** What's searched. */
    content: RefObject<HTMLDivElement | null>;
    /** What scrolls to a match. */
    scroller: RefObject<HTMLDivElement | null>;
    query: string;
    onQueryChange: (query: string) => void;
    /** Changes each time the shortcut is pressed again: refocuses the field. */
    focusKey: number;
    /** Before scrolling to a match (unpins the transcript). */
    onReveal: () => void;
    /** `refocus`: Escape, focus goes back to the prompt. */
    onClose: (refocus: boolean) => void;
};

/**
 * The find bar over a transcript: matches highlighted as you type, Enter /
 * Shift+Enter (or the arrows) step through them, Escape closes. Re-searched
 * as the transcript changes (streaming, rows opening), keeping the place.
 */
export function FindBar({ content, scroller, query, onQueryChange, focusKey, onReveal, onClose }: FindBarProps) {
    const input = useRef<HTMLInputElement>(null);
    const [ranges, setRanges] = useState<Range[]>([]);
    const [index, setIndex] = useState(0);

    useEffect(() => {
        input.current?.focus();
        input.current?.select();
    }, [focusKey]);

    const reveal = (range: Range | undefined) => {
        const el = scroller.current;
        if (!el || !range) return;
        onReveal();
        revealRange(el, range);
    };

    // A new query starts at the first match from the top of the view down.
    useEffect(() => {
        const timer = setTimeout(() => {
            const root = content.current;
            const el = scroller.current;
            if (!root || !el) return;
            const found = findRanges(root, query);
            const top = el.getBoundingClientRect().top;
            const first = Math.max(0, found.findIndex((r) => r.getBoundingClientRect().bottom > top));
            setRanges(found);
            setIndex(first);
            reveal(found[first]);
        }, 60);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);

    // The transcript changed under the matches: search again, staying put.
    useEffect(() => {
        const root = content.current;
        if (!root || !query.trim()) return;
        let timer = 0;
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = window.setTimeout(() => {
                const found = findRanges(root, query);
                setRanges(found);
                setIndex((i) => Math.max(0, Math.min(i, found.length - 1)));
            }, 200);
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [content, query]);

    useEffect(() => paintMatches(ranges, ranges[index]), [ranges, index]);
    useEffect(() => clearMatches, []);

    const step = (by: number) => {
        const n = ranges.length;
        if (n === 0) return;
        const next = (index + by + n) % n;
        setIndex(next);
        reveal(ranges[next]);
    };

    const count = !query.trim() ? "" : ranges.length === 0 ? "No results" : `${index + 1}/${ranges.length}`;

    return (
        <div
            role="search"
            data-find-skip
            className="pointer-events-auto flex h-9 w-full items-center gap-1 rounded-2xl border border-dark-600 bg-dark-850 pr-1 pl-2.5 shadow-lg shadow-black/40"
        >
            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-200" />
            <input
                ref={input}
                type="text"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        step(event.shiftKey ? -1 : 1);
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        onClose(true);
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        step(event.key === "ArrowUp" ? -1 : 1);
                    }
                }}
                placeholder="Find in chat"
                aria-label="Find in chat"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-dark-50 outline-none placeholder:text-dark-200"
            />
            <span
                aria-live="polite"
                className={ranges.length === 0 ? "shrink-0 text-xs text-dark-250" : "shrink-0 text-xs text-dark-100 tabular-nums"}
            >
                {count}
            </span>
            <IconButton label="Previous match" shortcut="Shift+Enter" disabled={ranges.length === 0} onClick={() => step(-1)}>
                <CaretUpIcon className="size-3.5" />
            </IconButton>
            <IconButton label="Next match" shortcut="Enter" disabled={ranges.length === 0} onClick={() => step(1)}>
                <CaretDownIcon className="size-3.5" />
            </IconButton>
            <IconButton label="Close" shortcut="Escape" onClick={() => onClose(false)}>
                <XIcon className="size-3.5" />
            </IconButton>
        </div>
    );
}
