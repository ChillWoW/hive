import { useMemo } from "react";
import type { WorkspaceEntry } from "@/proto";
import { fileMention, rankEntries } from "@/files";
import {
    completeToken,
    TOKEN_BOUNDARY,
    useCompletionMenu,
    type CompletionMenuState
} from "./useCompletionMenu";

/** Rows the menu shows at most. */
const LIMIT = 50;

/** The `@path` being typed: where it sits, and what's typed of it. */
type Token = { start: number; end: number; query: string };

/**
 * The `@` word around the caret: the `@` must start a word or
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
    if (sign > 0 && !TOKEN_BOUNDARY.test(draft[sign - 1]!)) return null;
    const query = draft.slice(sign + 1, at);
    // A quoted mention is a finished one.
    if (query.includes('"')) return null;
    let end = at;
    while (end < draft.length && !/\s/.test(draft[end]!)) end++;
    return { start: sign, end, query };
}

export type MentionMenuState = CompletionMenuState<WorkspaceEntry> & {
    /** Still waiting for the folder's first listing. */
    loading: boolean;
};

/**
 * `@` completion of the chat folder's files and folders: `@`
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
    const token = enabled ? tokenAt(draft, caret) : null;
    const query = token?.query;

    const matches = useMemo(() => {
        if (query === undefined || !entries) return [];
        if (query === "") return entries.slice(0, LIMIT);
        return rankEntries(query, entries, LIMIT);
    }, [entries, query]);

    const pick = (entry: WorkspaceEntry) => {
        if (!token) return;
        // A folder without spaces opens onto its contents instead of finishing.
        if (entry.dir && !/\s/.test(entry.path)) {
            const before = `${draft.slice(0, token.start)}@${entry.path}/`;
            complete(before + draft.slice(token.end), before.length);
            return;
        }
        const mention = fileMention(entry.dir ? `${entry.path}/` : entry.path);
        complete(...completeToken(draft, token.start, token.end, mention));
    };

    const menu = useCompletionMenu({
        draft,
        shown: token !== null,
        matches,
        filter: query,
        pick
    });

    return { ...menu, loading: entries === undefined };
}
