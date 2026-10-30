import { create } from "zustand";
import { persist } from "zustand/middleware";
import { errorText, git } from "@/git/store";
import type { GitHistoryComparison, GitHistoryCommit, GitHistoryPage } from "@/proto";
import { historyApi } from "./api";

export type HistoryColumn = "author" | "date" | "sha";
export const HISTORY_COLUMNS: readonly HistoryColumn[] = ["author", "date", "sha"];
export type AuthorDisplay = "avatar" | "name";

type Prefs = {
    columns: Record<HistoryColumn, boolean>;
    authorDisplay: AuthorDisplay;
    toggleColumn: (column: HistoryColumn) => void;
    setAuthorDisplay: (display: AuthorDisplay) => void;
    reset: () => void;
};

const DEFAULT_COLUMNS = { author: true, date: true, sha: true };

/** The history tab's columns, persisted as `hive.history`. */
export const useHistoryPrefs = create<Prefs>()(
    persist(
        (set) => ({
            columns: DEFAULT_COLUMNS,
            authorDisplay: "avatar",
            toggleColumn: (column) =>
                set((s) => ({ columns: { ...s.columns, [column]: !s.columns[column] } })),
            setAuthorDisplay: (authorDisplay) => set({ authorDisplay }),
            reset: () => set({ columns: DEFAULT_COLUMNS, authorDisplay: "avatar" })
        }),
        {
            name: "hive.history",
            partialize: ({ columns, authorDisplay }) => ({ columns, authorDisplay })
        }
    )
);

export type HistoryData = {
    commits: GitHistoryCommit[];
    branchTips: GitHistoryCommit[];
    headSha?: string;
    nextCursor?: number;
    headCommitCount?: number;
    comparison?: GitHistoryComparison;
};

export type HistorySearch = {
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
    fetchError?: string;
    search: HistorySearch;
    /** Author pictures by lowercased email. */
    avatars: Record<string, string>;
};

const EMPTY_SEARCH: HistorySearch = { query: "", loading: false };
const EMPTY: HistoryEntry = { loading: false, fetching: false, search: EMPTY_SEARCH, avatars: {} };

/** Each folder's history, by folder. */
export const useHistoryStore = create<{ entries: Record<string, HistoryEntry> }>()(() => ({
    entries: {}
}));

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
                update(cwd, () => ({ loading: false, error: errorText(error) }));
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
        (error) => update(cwd, () => ({ loading: false, error: errorText(error) }))
    );
}

/** As zeron: the loaded rows filter at once, the whole history's matches follow shortly. */
const SEARCH_DEBOUNCE = 70;

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
                updateSearch(cwd, () => ({ loading: false, error: errorText(error) }));
            }
        );
    if (wait > 0) searchTimers.set(cwd, window.setTimeout(run, wait));
    else void run();
}

/**
 * `git fetch --all`, then the history from the top again (and the branch
 * picker's ahead/behind).
 */
export async function fetchAll(cwd: string) {
    if (entryOf(cwd).fetching) return;
    update(cwd, () => ({ fetching: true, fetchError: undefined }));
    try {
        await historyApi.fetchAll(cwd);
        update(cwd, () => ({ fetching: false }));
        void git.refresh(cwd);
        await loadHistory(cwd, true);
    } catch (error) {
        update(cwd, () => ({ fetching: false, fetchError: errorText(error) }));
    }
}

/** Asks for the pictures of `commits`' authors (a page from `cursor`) not known yet. */
function resolveAvatars(cwd: string, commits: readonly GitHistoryCommit[], cursor: number) {
    const { columns, authorDisplay } = useHistoryPrefs.getState();
    if (!columns.author || authorDisplay !== "avatar") return;
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

/** The loaded pages' authors again, after the author column starts showing pictures. */
export function resolveLoadedAvatars(cwd: string) {
    const commits = entryOf(cwd).data?.commits ?? [];
    for (let cursor = 0; cursor < commits.length; cursor += 100) {
        resolveAvatars(cwd, commits.slice(cursor, cursor + 100), cursor);
    }
}
