import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    ArrowClockwiseIcon,
    ArrowsInLineVerticalIcon,
    CaretDownIcon,
    CloudArrowDownIcon,
    ListChecksIcon,
    MagnifyingGlassIcon,
    XIcon
} from "@phosphor-icons/react";
import { useFolderBusy, useGitRepo } from "@/git/store";
import { cn } from "@/lib/cn";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitHistoryCommit, GitHistoryRef } from "@/proto";
import { openCommitTab } from "@/rightbar/actions";
import { useActiveFolder } from "@/rightbar/folders";
import { Loading, Notice, TabToolbar, ToolButton } from "@/rightbar/parts";
import { usePanelLayout } from "@/stores/useLayoutStore";
import { DotMatrixSpinner, iconButtonClassName, Menu, Tooltip } from "@/ui";
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
import {
    fetchAll,
    columnWidth,
    HISTORY_COLUMNS,
    loadHistory,
    loadOlder,
    resolveLoadedAvatars,
    setSearchQuery,
    useHistoryEntry,
    useHistoryPrefs,
    type AuthorDisplay,
    type HistoryColumn,
    type HistoryEntry
} from "./store";

/**
 * The history tab: the open chat's checkout's
 * commits over every branch, remote branch and tag, children first, with a
 * lane graph; paged, searchable through the whole history, branches
 * foldable, or just their tips. A row opens its commit in a tab.
 */
export function HistoryTab() {
    const folder = useActiveFolder();
    // Folds, search and scroll belong to one folder.
    return <HistoryPane key={folder ?? ""} folder={folder} />;
}

const COLUMN_LABEL: Record<HistoryColumn, string> = { author: "Author", date: "Date", sha: "SHA" };

const NO_COMMITS: GitHistoryCommit[] = [];
const NO_HIDDEN = new Map<string, number>();

/** A callback ref, the element it's on (once mounted) and its size, kept up to date. */
function useSize<T extends HTMLElement>() {
    const [el, ref] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => {
            const { width, height } = entry!.contentRect;
            setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [el]);
    return [ref, size, el] as const;
}

function HistoryPane({ folder }: { folder: string | null }) {
    // Not read while the right sidebar is closed (it stays mounted).
    const shown = usePanelLayout().visible.right;
    const repo = useGitRepo(folder)?.repo;
    const busy = useFolderBusy(folder);
    const entry = useHistoryEntry(folder);
    const { columns, authorDisplay } = useHistoryPrefs();

    // Read when shown, when HEAD or the branch moves, when an agent's turn
    // there starts or ends, and on window focus (remote refs may have moved).
    const head = repo?.commit;
    const branch = repo?.branch;
    useEffect(() => {
        if (!folder || !shown) return;
        const read = () => void loadHistory(folder);
        read();
        return onWindowFocus(read);
    }, [folder, shown, head, branch, busy]);
    const wantsAvatars = columns.author && authorDisplay === "avatar";
    useEffect(() => {
        if (folder && wantsAvatars) resolveLoadedAvatars(folder);
    }, [folder, wantsAvatars]);

    const [tipsOnly, setTipsOnly] = useState(false);
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    const data = entry.data;
    const headSha = data?.headSha;
    const commits = data?.commits ?? NO_COMMITS;
    const query = entry.search.query;
    const searching = query.trim() !== "";

    const view = useMemo(() => {
        if (searching) {
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

    const shownColumns = HISTORY_COLUMNS.filter((c) => columns[c]);
    const columnsWidth = shownColumns.reduce((sum, c) => sum + columnWidth(c, authorDisplay), 0);
    const [paneRef, paneSize] = useSize<HTMLDivElement>();
    const [compact, setCompact] = useState(false);
    const geometry = graphGeometry(lanes, paneSize.width, columnsWidth, compact);
    useEffect(() => {
        if (geometry.compact !== compact) setCompact(geometry.compact);
    }, [geometry.compact, compact]);
    const commitWidth = Math.max(paneSize.width - geometry.width - columnsWidth, SUBJECT_MIN_WIDTH);
    const refWidth = refAreaWidth(commitWidth);

    // Hovering a path (or a row: its node's path) brings it forward.
    const [graphHover, setGraphHover] = useState<number>();
    const [rowHover, setRowHover] = useState<number>();
    const focus = graphHover ?? rowHover;

    const hasMore = searching
        ? entry.search.nextCursor !== undefined
        : !tipsOnly && data?.nextCursor !== undefined;
    const count = searching ? (entry.search.total ?? view.commits.length) : data?.headCommitCount;

    // Rows are drawn only near the viewport.
    const [listRef, listSize, list] = useSize<HTMLDivElement>();
    const [scrollTop, setScrollTop] = useState(0);
    const toTop = () => {
        list?.scrollTo({ top: 0 });
        setScrollTop(0);
    };

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

    const error = searching ? entry.search.error : entry.error;
    let body: ReactNode;
    if (!folder) {
        body = <Notice>Open a chat, or pick a folder for a new one, to see its history.</Notice>;
    } else if (repo === null || data === null) {
        body = <Notice>This folder isn't in a git checkout.</Notice>;
    } else if (data === undefined) {
        body = entry.error ? (
            <Notice tone="warning">{entry.error}</Notice>
        ) : (
            <Loading label="Reading history" />
        );
    } else if (view.commits.length === 0) {
        body =
            searching && entry.search.loading ? (
                <Loading label="Searching" />
            ) : (
                <Notice tone={error ? "warning" : undefined}>
                    {error ??
                        (searching
                            ? "No matching commits"
                            : tipsOnly
                              ? "No branch tips found"
                              : "No commits yet")}
                </Notice>
            );
    } else {
        const total = view.commits.length + (hasMore ? 1 : 0);
        const overscan = 8;
        const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
        const end = Math.min(
            total,
            Math.ceil((scrollTop + (listSize.height || 800)) / ROW_HEIGHT) + overscan
        );
        const rows: ReactNode[] = [];
        for (let i = start; i < end; i++) {
            const commit = view.commits[i];
            if (!commit) {
                rows.push(
                    <LoadMore
                        key="more"
                        pending={searching ? entry.search.loading : entry.loading}
                        failed={!!error}
                        onClick={() => folder && loadOlder(folder)}
                    />
                );
                continue;
            }
            const row = layout.rows[i]!;
            const foldRef =
                !searching && !tipsOnly ? commit.refs.find((r) => branchRefKey(r)) : undefined;
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
                    columns={shownColumns}
                    authorDisplay={authorDisplay}
                    avatar={entry.avatars[commit.authorEmail.trim().toLowerCase()]}
                    fold={
                        foldRef && foldKey
                            ? {
                                  ref: foldRef,
                                  folded: folded.has(foldKey),
                                  hidden: view.hidden.get(foldKey) ?? 0
                              }
                            : undefined
                    }
                    onToggleFold={toggleFold}
                    onGraphHover={setGraphHover}
                    onRowHover={setRowHover}
                    onOpen={() => folder && openCommitTab(folder, commit)}
                />
            );
        }
        body = (
            <>
                <div className="group/header relative flex h-6 shrink-0 items-center border-b border-white/[0.06] text-[10px] text-dark-250">
                    <div className="shrink-0" style={{ width: geometry.width }} />
                    <div className="min-w-0 flex-1">Commit</div>
                    {shownColumns.map((c) => (
                        <div
                            key={c}
                            className={cn("shrink-0 truncate", c === "author" && authorDisplay === "avatar" && "text-center")}
                            style={{ width: columnWidth(c, authorDisplay) }}
                        >
                            {COLUMN_LABEL[c]}
                        </div>
                    ))}
                    <ColumnsMenu />
                </div>
                <div
                    ref={listRef}
                    onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                    onMouseLeave={() => {
                        setGraphHover(undefined);
                        setRowHover(undefined);
                    }}
                    className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
                >
                    <div style={{ height: view.commits.length * ROW_HEIGHT + (hasMore ? 48 : 0) }}>
                        <div className="absolute inset-x-0" style={{ top: start * ROW_HEIGHT }}>
                            {rows}
                        </div>
                    </div>
                </div>
            </>
        );
    }

    return (
        <div ref={paneRef} className="@container flex min-h-0 flex-1 flex-col">
            <Toolbar
                folder={folder}
                branch={repo?.branch ?? (repo ? "HEAD" : undefined)}
                count={count}
                entry={entry}
                tipsOnly={tipsOnly}
                onTipsOnly={() => {
                    setTipsOnly((t) => !t);
                    // Leaving the tips view shows every branch unfolded.
                    setFolded(new Set());
                    toTop();
                }}
                onSearch={(value) => {
                    if (!folder) return;
                    setSearchQuery(folder, value);
                    toTop();
                }}
            />
            {entry.fetchError && <Banner>Fetch failed: {entry.fetchError}</Banner>}
            {error && view.commits.length > 0 && <Banner>{error}</Banner>}
            {body}
        </div>
    );
}

function Toolbar({
    folder,
    branch,
    count,
    entry,
    tipsOnly,
    onTipsOnly,
    onSearch
}: {
    folder: string | null;
    branch: string | undefined;
    count: number | undefined;
    entry: HistoryEntry;
    tipsOnly: boolean;
    onTipsOnly: () => void;
    onSearch: (query: string) => void;
}) {
    const comparison = entry.data?.comparison;
    const diverged = comparison && (comparison.ahead > 0 || comparison.behind > 0);
    const disabled = !folder || !entry.data;
    return (
        <TabToolbar>
            {branch && (
                <span className="min-w-0 max-w-40 shrink truncate px-1.5 font-mono text-[11.5px] text-dark-100">
                    {branch}
                </span>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden px-1">
                {count !== undefined && (
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-dark-200">
                        {count} {count === 1 ? "commit" : "commits"}
                    </span>
                )}
                {diverged && (
                    <Tooltip>
                        <Tooltip.Trigger
                            render={
                                // Extra detail: gone before it crowds the controls.
                                <span className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-[10.5px] @[420px]:flex">
                                    {comparison.ahead > 0 && (
                                        <span className="text-info/90">{comparison.ahead} ahead</span>
                                    )}
                                    {comparison.ahead > 0 && comparison.behind > 0 && (
                                        <span className="text-dark-250">·</span>
                                    )}
                                    {comparison.behind > 0 && (
                                        <span className="text-warning/85">{comparison.behind} behind</span>
                                    )}
                                </span>
                            }
                        />
                        <Tooltip.Content side="bottom">
                            Compared with {comparison.base}: {comparison.ahead} ahead, {comparison.behind}{" "}
                            behind
                        </Tooltip.Content>
                    </Tooltip>
                )}
            </div>
            {folder && entry.data && <SearchField query={entry.search.query} onChange={onSearch} />}
            <FetchButton
                fetching={entry.fetching}
                disabled={disabled}
                onClick={() => folder && void fetchAll(folder)}
            />
            <ToolButton
                label={tipsOnly ? "Show all commits" : "Show branch tips"}
                pressed={tipsOnly}
                disabled={disabled}
                onClick={onTipsOnly}
            >
                <ArrowsInLineVerticalIcon className="size-3.5" />
            </ToolButton>
            <ToolButton
                label="Refresh"
                disabled={!folder}
                onClick={() => folder && void loadHistory(folder, true)}
            >
                <ArrowClockwiseIcon className="size-3.5" />
            </ToolButton>
        </TabToolbar>
    );
}

/** A search button that opens into a field, closing again once it's empty and left. */
function SearchField({ query, onChange }: { query: string; onChange: (query: string) => void }) {
    const [open, setOpen] = useState(query !== "");
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (open) input.current?.focus();
    }, [open]);

    if (!open && !query) {
        return (
            <ToolButton label="Search commits" onClick={() => setOpen(true)}>
                <MagnifyingGlassIcon className="size-3.5" />
            </ToolButton>
        );
    }
    return (
        <label className="flex h-6 w-44 min-w-0 shrink cursor-text items-center gap-1.5 rounded-md bg-white/[0.05] px-2 transition-colors hover:bg-white/[0.07]">
            <MagnifyingGlassIcon className="size-3 shrink-0 text-dark-200" />
            <input
                ref={input}
                type="text"
                value={query}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    onChange("");
                    setOpen(false);
                }}
                onBlur={() => !query && setOpen(false)}
                placeholder="Subject or hash"
                aria-label="Search commits"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-[11.5px] text-dark-50 outline-none placeholder:text-dark-200"
            />
            {query && (
                <button
                    type="button"
                    aria-label="Clear search"
                    // Keeps the field focused.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onChange("")}
                    className="flex size-4 shrink-0 items-center justify-center rounded text-dark-200 hover:bg-white/10 hover:text-dark-50"
                >
                    <XIcon className="size-2.5" />
                </button>
            )}
        </label>
    );
}

function FetchButton({
    fetching,
    disabled,
    onClick
}: {
    fetching: boolean;
    disabled: boolean;
    onClick: () => void;
}) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        disabled={disabled || fetching}
                        onClick={onClick}
                        className={cn(
                            "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] text-dark-100 outline-none transition-colors",
                            "hover:bg-white/10 focus-visible:bg-white/10 disabled:pointer-events-none",
                            disabled && !fetching && "opacity-50",
                            fetching && "text-dark-250"
                        )}
                    >
                        {fetching ? (
                            <DotMatrixSpinner className="size-3" label="Fetching" />
                        ) : (
                            <CloudArrowDownIcon className="size-3.5 text-dark-200" />
                        )}
                        <span className="hidden @[340px]:inline">{fetching ? "Fetching…" : "Fetch all"}</span>
                    </button>
                }
            />
            <Tooltip.Content side="bottom">
                Get the latest from every remote
            </Tooltip.Content>
        </Tooltip>
    );
}

/** The header's columns menu: which columns show, and the author as a picture or a name. */
function ColumnsMenu() {
    const { columns, authorDisplay, toggleColumn, setAuthorDisplay, reset } = useHistoryPrefs();
    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <Menu.Trigger
                            aria-label="Columns"
                            className={cn(
                                iconButtonClassName,
                                "absolute top-0.5 right-1 size-5 opacity-0 group-hover/header:opacity-100 data-[popup-open]:opacity-100 focus-visible:opacity-100"
                            )}
                        >
                            <ListChecksIcon className="size-3" />
                        </Menu.Trigger>
                    }
                />
                <Tooltip.Content side="bottom">Columns</Tooltip.Content>
            </Tooltip>
            <Menu.Content side="bottom" align="end" sideOffset={4} className="w-44 min-w-0">
                {HISTORY_COLUMNS.map((c) => (
                    <Menu.CheckboxItem
                        key={c}
                        checked={columns[c]}
                        onCheckedChange={() => toggleColumn(c)}
                        closeOnClick={false}
                    >
                        {COLUMN_LABEL[c]}
                    </Menu.CheckboxItem>
                ))}
                <Menu.Separator />
                <Menu.RadioGroup
                    value={authorDisplay}
                    onValueChange={(value) => setAuthorDisplay(value as AuthorDisplay)}
                >
                    <Menu.GroupLabel>Author</Menu.GroupLabel>
                    <Menu.RadioItem value="avatar" closeOnClick={false}>
                        Picture
                    </Menu.RadioItem>
                    <Menu.RadioItem value="name" closeOnClick={false}>
                        Name
                    </Menu.RadioItem>
                </Menu.RadioGroup>
                <Menu.Separator />
                <Menu.Item onClick={reset}>Reset columns</Menu.Item>
            </Menu.Content>
        </Menu>
    );
}


function LoadMore({
    pending,
    failed,
    onClick
}: {
    pending: boolean;
    failed: boolean;
    onClick: () => void;
}) {
    return (
        <div className="flex h-12 items-center justify-center">
            <button
                type="button"
                disabled={pending}
                onClick={onClick}
                className={cn(
                    "flex h-7 items-center gap-1.5 rounded-[7px] border border-dark-600 bg-dark-800/70 px-3 text-[11px] text-dark-100 outline-none transition-colors",
                    "hover:border-dark-500 hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700 disabled:pointer-events-none disabled:text-dark-250"
                )}
            >
                {!pending &&
                    (failed ? (
                        <ArrowClockwiseIcon className="size-3 text-dark-250" />
                    ) : (
                        <CaretDownIcon className="size-3 text-dark-250" />
                    ))}
                {pending ? "Loading…" : failed ? "Retry" : "Load more"}
            </button>
        </div>
    );
}

function Banner({ children }: { children: ReactNode }) {
    return (
        <div className="shrink-0 truncate border-b border-danger/15 bg-danger/5 px-3 py-1.5 text-[11px] text-danger/85">
            {children}
        </div>
    );
}
