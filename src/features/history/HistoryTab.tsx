import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    ArrowClockwiseIcon,
    ArrowDownIcon,
    ArrowUpIcon,
    ClockCounterClockwiseIcon,
    CloudArrowDownIcon,
    GitBranchIcon,
    GitForkIcon,
    MagnifyingGlassIcon,
    WarningIcon,
    XIcon
} from "@phosphor-icons/react";
import { Centered, Notice } from "@/features/changes/DiffFiles";
import { useFolderBusy, useGitRepo } from "@/features/git/store";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { isShortcutOf } from "@/keybindings";
import { cn } from "@/lib/cn";
import { useMinuteClock } from "@/lib/time";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitHistoryCommit, GitHistoryRef } from "@/proto";
import { Button, DotMatrixSpinner, IconButton, Tooltip } from "@/ui";
import {
    branchRefKey,
    collapseBranchRuns,
    compactToVisible,
    graphGeometry,
    historyMatches,
    layoutGraph,
    refAreaWidth,
    ROW_HEIGHT,
    SUBJECT_MIN_WIDTH
} from "./graph";
import { HistoryRow } from "./HistoryRow";
import { openCommitTab } from "./open";
import { fetchAll, loadHistory, loadOlder, setSearchQuery, useHistoryEntry, type HistoryEntry } from "./store";

const NO_COMMITS: GitHistoryCommit[] = [];
const NO_HIDDEN = new Map<string, number>();
/** Rows drawn past each edge of the viewport. */
const OVERSCAN = 8;
/** The next page loads once the drawn rows come this close to the end. */
const LOAD_AHEAD = 20;

/** A callback ref, the element it's on (once mounted, which may be late) and its size. */
function useSize<T extends HTMLElement>() {
    const [el, ref] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        if (!el) return;
        const measure = () =>
            setSize((s) =>
                s.width === el.clientWidth && s.height === el.clientHeight
                    ? s
                    : { width: el.clientWidth, height: el.clientHeight }
            );
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [el]);
    return [ref, size, el] as const;
}

/** What a history tab was showing, kept while another tab is shown in its place. */
type ViewState = { scrollTop: number; tipsOnly: boolean; folded: ReadonlySet<string>; searching: boolean };
const views = new Map<string, ViewState>();

/**
 * A history tab: `cwd`'s commits over every branch, remote branch and tag,
 * children first, with a lane graph. Paged as it scrolls, searchable through
 * the whole history, branches foldable, or just their tips. A row opens its
 * commit in a tab.
 */
export function HistoryTab({ id, cwd }: { id: string; cwd: string }) {
    const saved = views.get(id);
    const repo = useGitRepo(cwd);
    const busy = useFolderBusy(cwd);
    const entry = useHistoryEntry(cwd);
    const now = useMinuteClock();
    const openShas = usePanelTabsStore((s) =>
        s.tabs
            .filter((t) => t.kind === "commit" && t.commit?.cwd === cwd)
            .map((t) => t.commit!.sha)
            .join(" ")
    );

    // Read when shown, when HEAD or the branch moves, when an agent's turn
    // there starts or ends, and on window focus (remote refs may have moved).
    const head = repo?.commit;
    const branch = repo?.branch;
    useEffect(() => {
        const read = () => void loadHistory(cwd);
        read();
        return onWindowFocus(read);
    }, [cwd, head, branch, busy]);

    const [tipsOnly, setTipsOnly] = useState(saved?.tipsOnly ?? false);
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => saved?.folded ?? new Set());
    const [searchOpen, setSearchOpen] = useState(saved?.searching ?? entry.search.query !== "");
    const data = entry.data;
    const headSha = data?.headSha;
    const commits = data?.commits ?? NO_COMMITS;
    const query = entry.search.query;
    const searching = query.trim() !== "";

    const view = useMemo(() => {
        if (searching) {
            // The loaded rows' matches until the whole history's come.
            const source = entry.search.results ?? commits;
            const visible = new Set(source.filter((c) => historyMatches(query, c)).map((c) => c.sha));
            return { commits: compactToVisible(source, visible), hidden: NO_HIDDEN };
        }
        if (tipsOnly) {
            // Tips aren't each other's parents: no lines between them.
            const tips = (data?.branchTips ?? NO_COMMITS).map((c) => ({ ...c, parentShas: [] }));
            return { commits: tips, hidden: NO_HIDDEN };
        }
        return collapseBranchRuns(commits, folded, headSha);
    }, [searching, query, entry.search.results, commits, tipsOnly, data?.branchTips, folded, headSha]);
    const layout = useMemo(() => layoutGraph(view.commits, headSha), [view.commits, headSha]);
    // As wide as the whole loaded graph, so folding doesn't shift every subject sideways.
    const loadedLanes = useMemo(() => layoutGraph(commits, headSha).laneCount, [commits, headSha]);
    const lanes = Math.max(layout.laneCount, loadedLanes);

    // The author, hash and age columns: about this much, at their widest.
    const [paneRef, { width: paneWidth }, pane] = useSize<HTMLDivElement>();
    const columnsWidth = paneWidth >= 704 ? 220 : paneWidth >= 576 ? 156 : 76;
    // The last answer, so the rail doesn't flicker at the threshold.
    const [compact, setCompact] = useState(false);
    const geometry = graphGeometry(lanes, paneWidth, columnsWidth, compact);
    if (geometry.compact !== compact) setCompact(geometry.compact);
    const subjectWidth = Math.max(paneWidth - geometry.width - columnsWidth, SUBJECT_MIN_WIDTH);
    const refWidth = refAreaWidth(subjectWidth);

    // Hovering a path (or a row: its node's path) brings it forward.
    const [graphHover, setGraphHover] = useState<number>();
    const [rowHover, setRowHover] = useState<number>();
    const focus = graphHover ?? rowHover;

    const hasMore = searching ? entry.search.nextCursor !== undefined : !tipsOnly && data?.nextCursor !== undefined;
    const pending = searching ? entry.search.loading : entry.loading;
    const error = searching ? entry.search.error : entry.error;
    const count = searching ? (entry.search.total ?? view.commits.length) : data?.headCommitCount;

    // Rows are drawn only near the viewport.
    const [listRef, { height: listHeight }, list] = useSize<HTMLDivElement>();
    const [scrollTop, setScrollTop] = useState(saved?.scrollTop ?? 0);
    // A list that (re)appears picks up where the tab was, as after showing a commit.
    const restoreScroll = useEffectEvent((el: HTMLElement) => {
        el.scrollTop = scrollTop;
    });
    useLayoutEffect(() => {
        if (list) restoreScroll(list);
    }, [list]);
    useEffect(() => {
        views.set(id, { scrollTop, tipsOnly, folded, searching: searchOpen });
    }, [id, scrollTop, tipsOnly, folded, searchOpen]);
    const toTop = () => {
        list?.scrollTo({ top: 0 });
        setScrollTop(0);
    };

    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(view.commits.length, Math.ceil((scrollTop + (listHeight || 800)) / ROW_HEIGHT) + OVERSCAN);

    // Scrolling near the end reads the next page.
    const nearEnd = end >= view.commits.length - LOAD_AHEAD;
    const loadMore = useEffectEvent(() => loadOlder(cwd));
    useEffect(() => {
        if (nearEnd && hasMore && !pending && !error) loadMore();
    }, [nearEnd, hasMore, pending, error, view.commits.length]);

    const toggleFold = (ref: GitHistoryRef) => {
        const key = branchRefKey(ref);
        if (!key) return;
        setTipsOnly(false);
        setFolded((s) => {
            const next = new Set(s);
            if (!next.delete(key)) next.add(key);
            return next;
        });
    };

    const search = (value: string) => {
        setSearchQuery(cwd, value);
        toTop();
    };
    const closeSearch = () => {
        search("");
        setSearchOpen(false);
        pane?.focus();
    };

    let body: ReactNode;
    if (repo === null || data === null) {
        body = <Notice icon={<ClockCounterClockwiseIcon className="size-5" />}>Not in a git repository.</Notice>;
    } else if (data === undefined) {
        body = entry.error ? (
            <Notice icon={<WarningIcon className="size-5 text-warning" />}>{entry.error}</Notice>
        ) : (
            <Centered>
                <DotMatrixSpinner label="Reading history" />
            </Centered>
        );
    } else if (view.commits.length === 0) {
        body =
            searching && entry.search.loading ? (
                <Centered>
                    <DotMatrixSpinner label="Searching" />
                </Centered>
            ) : (
                <Notice
                    icon={
                        error ? (
                            <WarningIcon className="size-5 text-warning" />
                        ) : searching ? (
                            <MagnifyingGlassIcon className="size-5" />
                        ) : (
                            <ClockCounterClockwiseIcon className="size-5" />
                        )
                    }
                >
                    {error ?? (searching ? "No commits match." : tipsOnly ? "No branches yet." : "No commits yet.")}
                </Notice>
            );
    } else {
        const shown = new Set(openShas.split(" "));
        const rows: ReactNode[] = [];
        for (let i = start; i < end; i++) {
            const commit = view.commits[i]!;
            const row = layout.rows[i]!;
            const foldRef = !searching && !tipsOnly ? commit.refs.find((r) => branchRefKey(r)) : undefined;
            const foldKey = foldRef && branchRefKey(foldRef);
            rows.push(
                <HistoryRow
                    key={commit.sha}
                    commit={commit}
                    row={row}
                    previousColor={i > 0 ? layout.rows[i - 1]!.color : undefined}
                    hasNext={i + 1 < view.commits.length || hasMore}
                    rail={!tipsOnly}
                    geometry={geometry}
                    focus={focus}
                    refWidth={refWidth}
                    currentBranch={branch}
                    avatar={entry.avatars[commit.authorEmail.trim().toLowerCase()]}
                    now={now}
                    open={shown.has(commit.sha)}
                    fold={
                        foldRef && foldKey
                            ? { ref: foldRef, folded: folded.has(foldKey), hidden: view.hidden.get(foldKey) ?? 0 }
                            : undefined
                    }
                    onToggleFold={toggleFold}
                    onGraphHover={setGraphHover}
                    onRowHover={setRowHover}
                    onOpen={(fresh) => openCommitTab(cwd, commit, { fresh })}
                />
            );
        }
        body = (
            <div
                ref={listRef}
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                onMouseLeave={() => {
                    setGraphHover(undefined);
                    setRowHover(undefined);
                }}
                className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
            >
                <div style={{ height: view.commits.length * ROW_HEIGHT + (hasMore || error ? 44 : 0) }}>
                    <div className="absolute inset-x-0" style={{ top: start * ROW_HEIGHT }}>
                        {rows}
                    </div>
                    {(hasMore || error) && (
                        <div
                            className="absolute inset-x-0 flex h-11 items-center justify-center"
                            style={{ top: view.commits.length * ROW_HEIGHT }}
                        >
                            {error ? (
                                <Button variant="ghost" size="xs" onClick={() => loadOlder(cwd)} className="text-muted">
                                    <ArrowClockwiseIcon />
                                    Couldn't read more. Retry
                                </Button>
                            ) : (
                                <DotMatrixSpinner label="Reading older commits" />
                            )}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div
            ref={paneRef}
            // Focusable, so the close-tab shortcut closes this tab, not the chat's.
            tabIndex={-1}
            onKeyDown={(event) => {
                if (isShortcutOf(event.nativeEvent, "closeTab")) {
                    event.preventDefault();
                    panelTabs.close(id);
                } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
                    event.preventDefault();
                    setSearchOpen(true);
                    pane?.querySelector<HTMLInputElement>("[data-history-search]")?.select();
                }
            }}
            className="@container flex min-h-0 flex-1 flex-col outline-none"
        >
            <Toolbar
                branch={repo ? (branch ?? "Detached HEAD") : undefined}
                count={count}
                searching={searching}
                entry={entry}
                tipsOnly={tipsOnly}
                searchOpen={searchOpen}
                ready={!!data}
                onSearch={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
                onTipsOnly={() => {
                    setTipsOnly((t) => !t);
                    // Leaving the tips view shows every branch unfolded.
                    setFolded(new Set());
                    toTop();
                }}
                onFetch={() => void fetchAll(cwd)}
                onRefresh={() => {
                    toTop();
                    void loadHistory(cwd, true);
                }}
            />
            {searchOpen && data && (
                <SearchRow
                    query={query}
                    loading={entry.search.loading}
                    error={searching && view.commits.length > 0 ? entry.search.error : undefined}
                    onChange={search}
                    onClose={closeSearch}
                />
            )}
            {body}
        </div>
    );
}

function Toolbar({
    branch,
    count,
    searching,
    entry,
    tipsOnly,
    searchOpen,
    ready,
    onSearch,
    onTipsOnly,
    onFetch,
    onRefresh
}: {
    branch: string | undefined;
    count: number | undefined;
    searching: boolean;
    entry: HistoryEntry;
    tipsOnly: boolean;
    searchOpen: boolean;
    ready: boolean;
    onSearch: () => void;
    onTipsOnly: () => void;
    onFetch: () => void;
    onRefresh: () => void;
}) {
    const comparison = entry.data?.comparison;
    const diverged = comparison && (comparison.ahead > 0 || comparison.behind > 0);
    const pressed = "aria-pressed:bg-hover aria-pressed:text-text";

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                {branch && (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <GitBranchIcon className="size-3.5 shrink-0 text-muted" />
                        <span className="truncate font-medium text-text">{branch}</span>
                    </span>
                )}
                {count !== undefined && (
                    <span className="shrink-0 whitespace-nowrap text-muted tabular-nums">
                        {count.toLocaleString()} {searching ? (count === 1 ? "match" : "matches") : count === 1 ? "commit" : "commits"}
                    </span>
                )}
                {diverged && !searching && (
                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                // Extra detail: gone before it crowds the buttons.
                                <span className="hidden shrink-0 items-center gap-1.5 text-[11px] tabular-nums @[24rem]:flex">
                                    {comparison.ahead > 0 && (
                                        <span className="flex items-center gap-0.5 text-success">
                                            <ArrowUpIcon className="size-3" weight="bold" />
                                            {comparison.ahead}
                                        </span>
                                    )}
                                    {comparison.behind > 0 && (
                                        <span className="flex items-center gap-0.5 text-warning">
                                            <ArrowDownIcon className="size-3" weight="bold" />
                                            {comparison.behind}
                                        </span>
                                    )}
                                </span>
                            }
                        />
                        <Tooltip.Content side="bottom">
                            {comparison.ahead} ahead, {comparison.behind} behind {comparison.base}
                        </Tooltip.Content>
                    </Tooltip>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                <IconButton
                    label="Search commits"
                    shortcut="Mod+F"
                    disabled={!ready}
                    aria-pressed={searchOpen}
                    onClick={onSearch}
                    className={pressed}
                >
                    <MagnifyingGlassIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label={tipsOnly ? "Show every commit" : "Show only branch tips"}
                    disabled={!ready}
                    aria-pressed={tipsOnly}
                    onClick={onTipsOnly}
                    className={pressed}
                >
                    <GitForkIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label={entry.fetching ? "Fetching…" : "Fetch from every remote"}
                    disabled={!ready || entry.fetching}
                    onClick={onFetch}
                >
                    {entry.fetching ? (
                        <DotMatrixSpinner className="size-3.5" label="Fetching" />
                    ) : (
                        <CloudArrowDownIcon className="size-3.5" />
                    )}
                </IconButton>
                <IconButton label="Refresh" onClick={onRefresh}>
                    <ArrowClockwiseIcon className={cn("size-3.5", entry.loading && "animate-spin")} />
                </IconButton>
            </div>
        </div>
    );
}

/** The search over every commit: subjects and hashes, by each word's letters in order. */
function SearchRow({
    query,
    loading,
    error,
    onChange,
    onClose
}: {
    query: string;
    loading: boolean;
    /** The whole history's search failed; the loaded rows' matches still show. */
    error: string | undefined;
    onChange: (query: string) => void;
    onClose: () => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => input.current?.focus(), []);

    return (
        <div className="shrink-0 border-b border-border px-2 py-1.5">
            {/* A label, so clicking the field's padding focuses it too. */}
            <label className="flex h-7 min-w-0 cursor-text items-center gap-1.5 rounded-md bg-raised px-2 transition-colors hover:bg-hover">
                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted" />
                <input
                    ref={input}
                    data-history-search
                    type="text"
                    value={query}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        onClose();
                    }}
                    placeholder="Search messages and hashes"
                    aria-label="Search commits"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                />
                {loading && <DotMatrixSpinner className="size-3" label="Searching" />}
                {error && (
                    <Tooltip>
                        <Tooltip.Trigger render={<WarningIcon className="size-3.5 shrink-0 text-warning" />} />
                        <Tooltip.Content side="bottom">Only loaded commits were searched: {error}</Tooltip.Content>
                    </Tooltip>
                )}
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close search"
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
                >
                    <XIcon className="size-3" />
                </button>
            </label>
        </div>
    );
}
