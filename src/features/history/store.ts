import { create } from "zustand";
import { git } from "@/features/git/store";
import { errorMessage } from "@/lib/errors";
import { toast } from "@/ui";
import type { GitHistoryComparison, GitHistoryCommit, GitHistoryPage } from "@/proto";
import { historyApi } from "./api";

/**
 * Each folder's history for the history tabs: the pages read so far, a
 * search through all of it, fetching, and authors' pictures.
 */

type HistoryData = {
    commits: GitHistoryCommit[];
    branchTips: GitHistoryCommit[];
    headSha?: string;
    nextCursor?: number;
    headCommitCount?: number;
    comparison?: GitHistoryComparison;
};

type HistorySearch = {
    query: string;
    /** The whole history's matches so far; until they come, the loaded rows are filtered. */
    results?: GitHistoryCommit[];
    nextCursor?: number;
    total?: number;
    loading: boolean;
    error?: string;
};

export type HistoryEntry = {
    /** Undefined until the first page, null outside a checkout. */
    data?: HistoryData | null;
    loading: boolean;
    error?: string;
    fetching: boolean;
    search: HistorySearch;
    /** Author pictures' URLs by lowercased email. */
    avatars: Record<string, string>;
};

const EMPTY_SEARCH: HistorySearch = { query: "", loading: false };
const EMPTY: HistoryEntry = { loading: false, fetching: false, search: EMPTY_SEARCH, avatars: {} };

/** Each folder's history, by folder. */
const useHistoryStore = create<{ entries: Record<string, HistoryEntry> }>()(() => ({
    entries: {}
}));

/** `cwd`'s history (an empty entry before the first read). */
export const useHistoryEntry = (cwd: string | null) =>
    useHistoryStore((s) => (cwd ? s.entries[cwd] : undefined)) ?? EMPTY;

const entryOf = (cwd: string) => useHistoryStore.getState().entries[cwd] ?? EMPTY;

function update(cwd: string, change: (entry: HistoryEntry) => Partial<HistoryEntry>) {
    useHistoryStore.setState((s) => {
        const entry = s.entries[cwd] ?? EMPTY;
        return { entries: { ...s.entries, [cwd]: { ...entry, ...change(entry) } } };
    });
}

function updateSearch(cwd: string, change: (search: HistorySearch) => Partial<HistorySearch>) {
    update(cwd, (e) => ({ search: { ...e.search, ...change(e.search) } }));
}

/** Requests for the current query; anything older is dropped when it lands. */
const searchGeneration = new Map<string, number>();
const searchTimers = new Map<string, number>();
const pageRequests = new Map<string, Promise<void>>();

const sameRows = (a: readonly GitHistoryCommit[], b: readonly GitHistoryCommit[]) =>
    a.length === b.length &&
    a.every((c, i) => c.sha === b[i]!.sha && JSON.stringify(c.refs) === JSON.stringify(b[i]!.refs));

/**
 * Reads the first page again. Unless `reset`, older pages already loaded
 * stay when the first page hasn't changed, so a refresh on focus keeps the
 * scroll; otherwise the history starts over from the top.
 */
export function loadHistory(cwd: string, reset = false): Promise<void> {
    const running = pageRequests.get(cwd);
    if (running && !reset) return running;
    update(cwd, () => ({ loading: true }));
    const request = historyApi
        .page(cwd, 0)
        .then(
            (page) => {
                // A newer request (a reset) replaced this one.
                if (pageRequests.get(cwd) !== request) return;
                const old = entryOf(cwd).data;
                const data = page ? merged(old, page, reset) : null;
                const changed = !old || !data || !sameRows(old.commits, data.commits);
                update(cwd, () => ({ data, loading: false, error: undefined }));
                if (data) resolveAvatars(cwd, page!.commits, 0);
                const query = entryOf(cwd).search.query;
                if (changed && query.trim()) requestSearch(cwd, query, 0, 0);
            },
            (error) => {
                if (pageRequests.get(cwd) !== request) return;
                update(cwd, () => ({ loading: false, error: errorMessage(error, "Git failed.") }));
            }
        )
        .finally(() => {
            if (pageRequests.get(cwd) === request) pageRequests.delete(cwd);
        });
    pageRequests.set(cwd, request);
    return request;
}

function merged(old: HistoryData | null | undefined, page: GitHistoryPage, reset: boolean): HistoryData {
    const fresh: HistoryData = {
        commits: page.commits,
        branchTips: page.branchTips,
        headSha: page.headSha,
        nextCursor: page.nextCursor,
        headCommitCount: page.headCommitCount,
        comparison: page.comparison
    };
    if (reset || !old || old.commits.length <= page.commits.length) return fresh;
    if (!sameRows(old.commits.slice(0, page.commits.length), page.commits)) return fresh;
    // The same top: keep what was loaded below it (and the same objects, so rows don't redraw).
    return { ...fresh, commits: old.commits, nextCursor: old.nextCursor };
}

/** The next page of the history, or of the search while one is on. */
export function loadOlder(cwd: string) {
    const entry = entryOf(cwd);
    if (entry.search.query.trim()) {
        const { nextCursor, loading } = entry.search;
        if (nextCursor !== undefined && !loading) requestSearch(cwd, entry.search.query, nextCursor, 0);
        return;
    }
    const cursor = entry.data?.nextCursor;
    if (cursor === undefined || entry.loading) return;
    update(cwd, () => ({ loading: true, error: undefined }));
    historyApi.page(cwd, cursor).then(
        (page) => {
            update(cwd, (e) => {
                if (!page || !e.data) return { loading: false };
                const seen = new Set(e.data.commits.map((c) => c.sha));
                const commits = e.data.commits.concat(page.commits.filter((c) => !seen.has(c.sha)));
                return { loading: false, data: { ...e.data, commits, nextCursor: page.nextCursor } };
            });
            if (page) resolveAvatars(cwd, page.commits, cursor);
        },
        (error) =>
            update(cwd, () => ({ loading: false, error: errorMessage(error, "Git failed.") }))
    );
}

/** The loaded rows filter at once, the whole history's matches follow shortly. */
const SEARCH_DEBOUNCE = 70;

/** The search's text; a new query starts over, an empty one ends the search. */
export function setSearchQuery(cwd: string, value: string) {
    const query = value.trimStart();
    if (entryOf(cwd).search.query === query) return;
    update(cwd, () => ({ search: { ...EMPTY_SEARCH, query } }));
    if (query.trim()) requestSearch(cwd, query, 0, SEARCH_DEBOUNCE);
    else bumpSearch(cwd);
}

function bumpSearch(cwd: string) {
    const generation = (searchGeneration.get(cwd) ?? 0) + 1;
    searchGeneration.set(cwd, generation);
    window.clearTimeout(searchTimers.get(cwd));
    return generation;
}

function requestSearch(cwd: string, query: string, cursor: number, wait: number) {
    const generation = bumpSearch(cwd);
    updateSearch(cwd, () => ({ loading: true, error: undefined }));
    const run = () =>
        historyApi.search(cwd, query, cursor).then(
            (page) => {
                if (searchGeneration.get(cwd) !== generation) return;
                updateSearch(cwd, (s) => {
                    if (!page) return { loading: false };
                    const before = cursor === 0 ? [] : (s.results ?? []);
                    const seen = new Set(before.map((c) => c.sha));
                    return {
                        loading: false,
                        results: before.concat(page.commits.filter((c) => !seen.has(c.sha))),
                        nextCursor: page.nextCursor,
                        total: page.totalCount ?? s.total
                    };
                });
                if (page) resolveAvatars(cwd, page.commits, cursor);
            },
            (error) => {
                if (searchGeneration.get(cwd) !== generation) return;
                // The loaded rows' matches stay useful.
                updateSearch(cwd, () => ({
                    loading: false,
                    error: errorMessage(error, "Git failed.")
                }));
            }
        );
    if (wait > 0) searchTimers.set(cwd, window.setTimeout(run, wait));
    else void run();
}

/**
 * `git fetch --all`, then the history from the top again (and the branch
 * picker's checkout).
 */
export async function fetchAll(cwd: string) {
    if (entryOf(cwd).fetching) return;
    update(cwd, () => ({ fetching: true }));
    try {
        await historyApi.fetchAll(cwd);
        update(cwd, () => ({ fetching: false }));
        void git.refresh(cwd);
        await loadHistory(cwd, true);
    } catch (error) {
        update(cwd, () => ({ fetching: false }));
        toast.error({ title: "Couldn't fetch", description: errorMessage(error, "Git failed.") });
    }
}

/** Asks for the pictures of `commits`' authors (a page from `cursor`) not known yet. */
function resolveAvatars(cwd: string, commits: readonly GitHistoryCommit[], cursor: number) {
    const known = entryOf(cwd).avatars;
    const authors = new Map<string, { sha: string; email: string }>();
    for (const commit of commits) {
        const email = commit.authorEmail.trim().toLowerCase();
        if (email && !(email in known) && !authors.has(email)) {
            authors.set(email, { sha: commit.sha, email: commit.authorEmail });
        }
    }
    if (authors.size === 0) return;
    historyApi.avatars(cwd, [...authors.values()], cursor).then(
        (found) => {
            if (Object.keys(found).length > 0) {
                update(cwd, (e) => ({ avatars: { ...e.avatars, ...found } }));
            }
        },
        () => {}
    );
}
