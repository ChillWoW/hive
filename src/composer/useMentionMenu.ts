import { useEffect, useMemo, useState } from "react";
import type { WorkspaceEntry } from "@/proto";
import { fileMention, rankEntries } from "@/files";

/** Rows the menu shows at most. */
const LIMIT = 50;
/** What may come right before the `@` that starts a mention. */
const BOUNDARY = /[\s([{]/;

/** The `@path` being typed: where it sits, and what's typed of it. */
type Token = { start: number; end: number; query: string };

/**
 * The `@` word around the caret, as in zeron: the `@` must start a word or
 * follow an opening bracket, so `name@example.com` isn't one. The token runs
 * on past the caret to the next space, all of it replaced on a pick.
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
    index: number;
    setIndex: (index: number) => void;
    pick: (entry: WorkspaceEntry) => void;
    /** Handles the menu's keys; true when it took the event. */
    onKeyDown: (event: React.KeyboardEvent) => boolean;
};

/**
 * `@` completion of the chat folder's files and folders, as in zeron: `@`
 * and part of a path or name lists the best matches (the shallowest entries
 * before anything is typed). Arrows move, Tab or Enter picks, Escape closes
 * it until the text changes. A file completes to `@path `; a folder to
 * `@folder/`, the menu staying open on what's inside it.
 */
export function useMentionMenu({
    draft,
    caret,
    entries,
    enabled,
    complete
}: {
    draft: string;
    /** The caret's offset in `draft`. */
    caret: number;
    /** The folder's files; undefined while they're first listed. */
    entries: WorkspaceEntry[] | undefined;
    enabled: boolean;
    /** Sets the field's text, with the caret at `caret`. */
    complete: (text: string, caret: number) => void;
}): MentionMenuState {
    const [index, setIndex] = useState(0);
    const [dismissed, setDismissed] = useState<string | null>(null);

    const token = enabled ? tokenAt(draft, caret) : null;
    const query = token?.query;
    const open = token !== null && dismissed !== draft;

    const matches = useMemo(() => {
        if (query === undefined || !entries) return [];
        if (query === "") return entries.slice(0, LIMIT);
        return rankEntries(query, entries, LIMIT);
    }, [entries, query]);

    // A new filter starts from the top.
    useEffect(() => setIndex(0), [query]);

    const pick = (entry: WorkspaceEntry) => {
        if (!token) return;
        const after = draft.slice(token.end);
        // A folder without spaces opens onto its contents instead of finishing.
        if (entry.dir && !/\s/.test(entry.path)) {
            const before = `${draft.slice(0, token.start)}@${entry.path}/`;
            complete(before + after, before.length);
            return;
        }
        const mention = fileMention(entry.dir ? `${entry.path}/` : entry.path);
        const gap = after.startsWith(" ") ? "" : " ";
        const before = draft.slice(0, token.start) + mention + gap;
        complete(before + after, before.length + (gap ? 0 : 1));
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
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
                if (event.shiftKey || event.nativeEvent.isComposing) return false;
                const entry = matches[Math.min(index, matches.length - 1)];
                if (!entry) return false;
                pick(entry);
                return true;
            }
            default:
                return false;
        }
    };

    return {
        open,
        loading: entries === undefined,
        matches,
        index,
        setIndex,
        pick,
        onKeyDown
    };
}
