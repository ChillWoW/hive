import { useEffect } from "react";
import { create } from "zustand";
import type { TextQuery, TextSearch } from "@/proto";
import { backend } from "@/lib/backend";
import { errorMessage } from "@/lib/errors";

/** How long the query rests before it's searched for. */
const DEBOUNCE_MS = 200;

/** A made-up match for plain `bun run dev`, where there's no backend. */
const fake = ({ text }: TextQuery): TextSearch => ({
    files: [
        {
            path: "src/App.tsx",
            matches: [
                {
                    line: 1,
                    column: 4,
                    length: text.length,
                    preview: `// ${text} (a made-up match)`,
                    previewStart: 3,
                    previewLength: text.length
                }
            ]
        }
    ],
    truncated: false
});

type TextSearchState = {
    /** What `result` (or `error`) is for (`searchKey`); the search field may be past it. */
    key: string;
    result: TextSearch | null;
    error: string | null;
};

const useTextSearchStore = create<TextSearchState>()(() => ({ key: "", result: null, error: null }));

/** Names a search: the folder and everything asked of it. */
const searchKey = (cwd: string, q: TextQuery) => [cwd, q.text, q.caseSensitive, q.wholeWord, q.regex].join("\0");

/** The search asked for last; an earlier one's answer is dropped (and the backend stops it). */
let latest = 0;

/** Searches `cwd`'s files for `query` (`src-tauri/src/search.rs`). */
export async function searchText(cwd: string, query: TextQuery): Promise<void> {
    const id = ++latest;
    const key = searchKey(cwd, query);
    try {
        const result = await backend<TextSearch>("search_text", { cwd, query, id }, () => fake(query));
        if (id === latest) useTextSearchStore.setState({ key, result, error: null });
    } catch (error) {
        if (id !== latest) return;
        useTextSearchStore.setState({ key, result: null, error: errorMessage(error, "The search failed.") });
    }
}

/**
 * What the last text search found, searching `cwd` for `text` shortly after
 * anything asked changes (not while `text` is blank). `pending` while that
 * isn't this search's yet: the result before it stays shown meanwhile.
 */
export function useTextSearch(cwd: string, { text, caseSensitive, wholeWord, regex }: TextQuery) {
    const state = useTextSearchStore();
    const wanted = cwd !== "" && text.trim() !== "";
    useEffect(() => {
        if (!wanted) return;
        const query = { text, caseSensitive, wholeWord, regex };
        const timer = setTimeout(() => void searchText(cwd, query), DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [wanted, cwd, text, caseSensitive, wholeWord, regex]);
    // Another folder's results aren't this one's.
    const ours = state.key.startsWith(`${cwd}\0`);
    return {
        pending: state.key !== searchKey(cwd, { text, caseSensitive, wholeWord, regex }),
        result: ours ? state.result : null,
        error: ours ? state.error : null
    };
}
