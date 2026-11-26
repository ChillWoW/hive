import { useMemo, useState, type KeyboardEvent } from "react";
import type { WorkspaceEntry } from "@/proto";
import { fileMention, rankEntries, useWorkspaceFiles } from "./files";

/** Rows the menu shows at most. */
const LIMIT = 50;

/** What may come right before the `@` that starts a mention. */
const BOUNDARY = /[\s([{]/;

/** The `@path` being typed: where it sits, and what's typed of it. */
type Token = { start: number; end: number; query: string };

/**
 * The `@` word around the caret: the `@` must start a word or follow an
 * opening bracket, so `name@example.com` isn't one. The token runs on past
 * the caret to the next space, all of it replaced on a pick.
 */
function tokenAt(draft: string, caret: number): Token | null {
    const at = Math.min(caret, draft.length);
    let wordStart = at;
    while (wordStart > 0 && !/\s/.test(draft[wordStart - 1]!)) wordStart--;
    const offset = draft.slice(wordStart, at).lastIndexOf("@");
    if (offset === -1) return null;
    const sign = wordStart + offset;
    if (sign > 0 && !BOUNDARY.test(draft[sign - 1]!)) return null;
    const query = draft.slice(sign + 1, at);
    // A quoted mention is a finished one.
    if (query.includes('"')) return null;
    let end = at;
    while (end < draft.length && !/\s/.test(draft[end]!)) end++;
    return { start: sign, end, query };
}

export type MentionMenuState = {
    open: boolean;
    /** Still waiting for the folder's first listing. */
    loading: boolean;
    matches: WorkspaceEntry[];
    highlighted: number;
    setHighlighted: (index: number) => void;
    pick: (entry: WorkspaceEntry) => void;
    /** The menu's keys, while it's open; true when one was taken. */
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
};

/**
 * `@` completion of the chat folder's files and folders: `@` and part of a
 * path or name lists the best matches (the shallowest entries before
 * anything is typed). Arrows move, Tab or Enter picks, Escape closes it
 * until the text changes. A file completes to `@path `; a folder to
 * `@folder/`, the menu staying open on what's inside it.
 */
export function useMentionMenu({
    draft,
    caret,
    cwd,
    complete
}: {
    draft: string;
    /** The caret's offset in `draft`. */
    caret: number;
    /** The chat's folder; none turns the menu off. */
    cwd: string;
    /** Sets the field's text, with the caret at `caret`. */
    complete: (text: string, caret: number) => void;
}): MentionMenuState {
    const entries = useWorkspaceFiles(cwd, !!cwd);
    const token = cwd ? tokenAt(draft, caret) : null;
    const query = token?.query;

    const matches = useMemo(() => {
        if (query === undefined || !entries) return [];
        if (query === "") return entries.slice(0, LIMIT);
        return rankEntries(query, entries, LIMIT);
    }, [entries, query]);

    // Which match is highlighted, for the query it was picked at: a new query starts at the top.
    const [highlight, setHighlight] = useState({ query, index: 0 });
    const highlighted =
        highlight.query === query ? Math.min(highlight.index, Math.max(matches.length - 1, 0)) : 0;
    const setHighlighted = (index: number) => setHighlight({ query, index });
    /** The draft the menu was closed at (Escape); it opens again once that changes. */
    const [dismissedAt, setDismissedAt] = useState<string>();
    const open = token !== null && dismissedAt !== draft;

    const pick = (entry: WorkspaceEntry) => {
        if (!token) return;
        // A folder without spaces opens onto its contents instead of finishing.
        if (entry.dir && !/\s/.test(entry.path)) {
            const before = `${draft.slice(0, token.start)}@${entry.path}/`;
            complete(before + draft.slice(token.end), before.length);
            return;
        }
        const after = draft.slice(token.end);
        const gap = after.startsWith(" ") ? "" : " ";
        const before = draft.slice(0, token.start) + fileMention(entry.dir ? `${entry.path}/` : entry.path) + gap;
        complete(before + after, before.length + (gap ? 0 : 1));
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!open || event.nativeEvent.isComposing) return false;
        if (event.key === "Escape") {
            setDismissedAt(draft);
            event.stopPropagation();
            return true;
        }
        if (matches.length === 0) return false;
        switch (event.key) {
            case "ArrowDown":
                setHighlighted((highlighted + 1) % matches.length);
                return true;
            case "ArrowUp":
                setHighlighted((highlighted - 1 + matches.length) % matches.length);
                return true;
            case "Tab":
            case "Enter": {
                if (event.shiftKey) return false;
                const entry = matches[highlighted];
                if (entry) pick(entry);
                return true;
            }
            default:
                return false;
        }
    };

    return { open, loading: entries === undefined, matches, highlighted, setHighlighted, pick, onKeyDown };
}
