import { useEffect, useState } from "react";

/** What may come right before the `/`, `$` or `@` that starts a token. */
export const TOKEN_BOUNDARY = /[\s([{]/;

/**
 * `draft` with the token from `start` to `end` replaced by `name` and a
 * space (reusing one already after it), and the caret after that space.
 */
export function completeToken(
    draft: string,
    start: number,
    end: number,
    name: string
): [text: string, caret: number] {
    const after = draft.slice(end);
    const gap = after.startsWith(" ") ? "" : " ";
    const before = draft.slice(0, start) + name + gap;
    return [before + after, before.length + (gap ? 0 : 1)];
}

/** A menu completing what's typed in the composer, above the box. */
export type CompletionMenuState<T> = {
    open: boolean;
    matches: T[];
    index: number;
    setIndex: (index: number) => void;
    pick: (item: T) => void;
    /** Handles the menu's keys; true when it took the event. */
    onKeyDown: (event: KeyboardEvent) => boolean;
};

/**
 * The keys and highlight of a completion menu: arrows move (wrapping), Tab
 * or Enter picks the highlighted match (unless `passEnter` lets an Enter
 * through), Escape closes the menu until the text changes. A new `filter`
 * starts from the top.
 */
export function useCompletionMenu<T>({
    draft,
    shown,
    matches,
    filter,
    pick,
    passEnter
}: {
    draft: string;
    /** Whether the menu would be open, before Escape. */
    shown: boolean;
    matches: T[];
    /** What the matches are filtered by. */
    filter: unknown;
    pick: (item: T) => void;
    passEnter?: (item: T) => boolean;
}): CompletionMenuState<T> {
    const [index, setIndex] = useState(0);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const open = shown && dismissed !== draft;

    useEffect(() => setIndex(0), [filter]);

    const onKeyDown = (event: KeyboardEvent) => {
        if (!open) return false;
        if (event.key === "Escape") {
            setDismissed(draft);
            return true;
        }
        if (matches.length === 0) return false;
        switch (event.key) {
            case "ArrowDown":
                setIndex((index + 1) % matches.length);
                return true;
            case "ArrowUp":
                setIndex((index - 1 + matches.length) % matches.length);
                return true;
            case "Tab":
            case "Enter": {
                // Enter mid-composition is the IME accepting a candidate.
                if (event.shiftKey || event.isComposing) return false;
                const item = matches[Math.min(index, matches.length - 1)];
                if (item === undefined) return false;
                if (event.key === "Enter" && passEnter?.(item)) return false;
                pick(item);
                return true;
            }
            default:
                return false;
        }
    };

    return { open, matches, index, setIndex, pick, onKeyDown };
}
