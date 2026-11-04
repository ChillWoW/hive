import { useEffect, useRef, useState } from "react";
import type { TextSearchOptions, TextSearchResult } from "@/proto";
import { useTurnEnded } from "@/git/store";
import { errorMessage } from "@/lib/errors";
import { useFolderWatch } from "@/lib/folderWatch";
import { onWindowFocus } from "@/lib/windowFocus";
import { searchText } from "./api";

/** Typing settles this long before a search starts. */
const DEBOUNCE_MS = 200;
/** Files changing settle this long before the search runs again. */
const RERUN_MS = 600;

export type TextSearchState = {
    /** The last search's result; kept while the next one runs. */
    result: TextSearchResult | null;
    error: string | null;
    searching: boolean;
};

/**
 * Searches the text inside `cwd`'s files for `query` (ignored files too with
 * `all`), again as files there change, an agent's turn there ends or the
 * window regains focus. Only the newest search's answer is kept.
 */
export function useTextSearch(
    cwd: string,
    query: string,
    options: TextSearchOptions,
    all: boolean
): TextSearchState {
    const [state, setState] = useState<TextSearchState>({
        result: null,
        error: null,
        searching: false
    });
    const [tick, setTick] = useState(0);
    const seq = useRef(0);
    const { caseSensitive, wholeWord, regex } = options;

    useEffect(() => {
        const id = ++seq.current;
        if (!query) {
            setState({ result: null, error: null, searching: false });
            return;
        }
        setState((s) => ({ ...s, searching: true }));
        const timer = window.setTimeout(() => {
            searchText(cwd, query, { caseSensitive, wholeWord, regex }, all).then(
                (result) => {
                    if (id === seq.current) setState({ result, error: null, searching: false });
                },
                (error: unknown) => {
                    if (id !== seq.current) return;
                    setState({ result: null, error: errorMessage(error), searching: false });
                }
            );
        }, DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [cwd, query, caseSensitive, wholeWord, regex, all, tick]);

    // Re-run, a little after the last change, while there's a query.
    const rerun = useRef<number | undefined>(undefined);
    const live = useRef(false);
    live.current = query !== "";
    const scheduleRerun = () => {
        if (!live.current) return;
        window.clearTimeout(rerun.current);
        rerun.current = window.setTimeout(() => setTick((t) => t + 1), RERUN_MS);
    };
    useEffect(() => () => window.clearTimeout(rerun.current), []);
    useFolderWatch(cwd, (change) => {
        if (change.paths.length > 0 || change.overflow) scheduleRerun();
    });
    useTurnEnded(cwd, scheduleRerun);
    useEffect(() => onWindowFocus(() => scheduleRerun()), []);

    return state;
}
