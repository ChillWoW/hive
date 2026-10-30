import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    ArrowClockwiseIcon,
    ArrowsInLineVerticalIcon,
    ArrowsOutLineVerticalIcon,
    CaretDownIcon,
    CloudArrowDownIcon,
    CloudIcon,
    GitBranchIcon,
    ListChecksIcon,
    MagnifyingGlassIcon,
    TagIcon,
    XIcon
} from "@phosphor-icons/react";
import { useFolderBusy, useGitRepo } from "@/git/store";
import { cn } from "@/lib/cn";
import type { GitHistoryCommit, GitHistoryRef } from "@/proto";
import { openCommitTab } from "@/rightbar/actions";
import { useActiveFolder } from "@/rightbar/folders";
import { ToolButton } from "@/rightbar/ToolButton";
import { usePanelLayout } from "@/stores/useLayoutStore";
import { DotMatrixSpinner, iconButtonClassName, Menu, Tooltip } from "@/ui";
import {
    branchRefKey,
    collapseBranchRuns,
    compactToVisible,
    graphGeometry,
    HEAD_RING_PADDING,
    historyMatches,
    laneX,
    layoutGraph,
    NODE_RADIUS,
    REF_GAP,
    refAreaWidth,
    ROW_HEIGHT,
    ROW_OVERLAP,
    SUBJECT_MIN_WIDTH,
    visibleRefCount,
    type Geometry,
    type GraphRow,
    type GraphSegment
} from "./graph";
import {
    fetchAll,
    HISTORY_COLUMNS,
    loadHistory,
    loadOlder,
    resolveLoadedAvatars,
    setSearchQuery,
    useHistoryPrefs,
    useHistoryStore,
    type AuthorDisplay,
    type HistoryColumn,
    type HistoryEntry
} from "./store";

/**
 * The history tab, as zeron's History surface: the open chat's checkout's
 * commits over every branch, remote branch and tag, children first, with a
 * lane graph; paged, searchable through the whole history, branches
 * foldable, or just their tips. A row opens its commit in a tab.
 */
export function HistoryTab() {
    const folder = useActiveFolder();
    // Folds, search and scroll belong to one folder.
    return <HistoryPane key={folder ?? ""} folder={folder} />;
}

// Colours: zeron's graph palette at 72% saturation.

function desaturate(hex: string, amount = 0.72) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number
    ];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    if (d) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
    }
    const s = (d ? d / (1 - Math.abs(2 * l - 1)) : 0) * amount;
    return `hsl(${Math.round(h * 60 + 360) % 360} ${(s * 100).toFixed(1)}% ${(l * 100).toFixed(1)}%)`;
}

const BLUE = "#6fb3f2";
const VIOLET = "#b39cf0";
const PALETTE = [BLUE, VIOLET, "#a5e075", "#f0a45d", "#ff616e", "#828282"].map((c) => desaturate(c));
/** The side panels' background (`dark-850`), which dimmed paths fade into. */
const PANEL_BG = "#1a1a1a";
const colorOf = (id: number) => PALETTE[id % PALETTE.length]!;
/** Opaque, so overlapping row seams don't stack into dots (as zeron mixes them). */
const dimmed = (color: string) => `color-mix(in srgb, ${color} 24%, ${PANEL_BG})`;

const STROKE = 1.5;
const HIT_WIDTH = 11;
const UNFOCUSED_ROW_OPACITY = 0.6;

/** Branches as the update button (`info`): local on /20, remote on /10. */
const REF_STYLE: Record<
    GitHistoryRef["kind"],
    { className: string; label: string; Icon: typeof GitBranchIcon }
> = {
    branch: { className: "bg-info/20 text-info", label: "Branch", Icon: GitBranchIcon },
    remote: { className: "bg-info/10 text-info", label: "Remote branch", Icon: CloudIcon },
    tag: { className: "bg-[#f0a45d]/10 text-[#f0a45d]/90", label: "Tag", Icon: TagIcon }
};

const COLUMN_LABEL: Record<HistoryColumn, string> = { author: "Author", date: "Date", sha: "SHA" };

function columnWidth(column: HistoryColumn, display: AuthorDisplay) {
    if (column === "author") return display === "avatar" ? 48 : 104;
    return column === "date" ? 88 : 74;
}

const NO_COMMITS: GitHistoryCommit[] = [];
const NO_HIDDEN = new Map<string, number>();
const EMPTY_ENTRY: HistoryEntry = {
    loading: false,
    fetching: false,
    search: { query: "", loading: false },
    avatars: {}
};

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
    const repoEntry = useGitRepo(folder);
    const repo = repoEntry?.repo;
    const busy = useFolderBusy(folder);
    const entry = useHistoryStore((s) => (folder ? s.entries[folder] : undefined)) ?? EMPTY_ENTRY;
    const { columns, authorDisplay } = useHistoryPrefs();

    // Read when shown, when HEAD or the branch moves, when an agent's turn
    // there starts or ends, and on window focus (remote refs may have moved).
    const head = repo?.commit;
    const branch = repo?.branch;
    useEffect(() => {
        if (folder && shown) void loadHistory(folder);
    }, [folder, shown, head, branch, busy]);
    useEffect(() => {
        if (!folder || !shown) return;
        const onFocus = () => void loadHistory(folder);
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [folder, shown]);
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
            <div className="flex flex-1 items-center justify-center">
                <DotMatrixSpinner label="Reading history" />
            </div>
        );
    } else if (view.commits.length === 0) {
        body =
            searching && entry.search.loading ? (
                <div className="flex flex-1 items-center justify-center">
                    <DotMatrixSpinner label="Searching" />
                </div>
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
                    // Leaving the tips view shows every branch unfolded, as zeron does.
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
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-dark-600 px-2">
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
        </div>
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

type Fold = { ref: GitHistoryRef; folded: boolean; hidden: number };

function HistoryRow({
    commit,
    row,
    previousColor,
    hasNext,
    rail,
    geometry,
    focus,
    refWidth,
    columns,
    authorDisplay,
    avatar,
    fold,
    onToggleFold,
    onGraphHover,
    onRowHover,
    onOpen
}: {
    commit: GitHistoryCommit;
    row: GraphRow;
    previousColor: number | undefined;
    hasNext: boolean;
    /** In the one-lane rail, join rows (not in the tips view: they aren't related). */
    rail: boolean;
    geometry: Geometry;
    focus: number | undefined;
    refWidth: number;
    columns: HistoryColumn[];
    authorDisplay: AuthorDisplay;
    avatar: string | undefined;
    fold: Fold | undefined;
    onToggleFold: (ref: GitHistoryRef) => void;
    onGraphHover: (color: number | undefined) => void;
    onRowHover: (color: number | undefined) => void;
    onOpen: () => void;
}) {
    const faded = focus !== undefined && focus !== row.color;
    return (
        <div
            role="button"
            tabIndex={-1}
            onClick={onOpen}
            onMouseEnter={() => onRowHover(row.color)}
            className="flex cursor-pointer items-center text-[11px] transition-colors hover:bg-white/[0.03]"
            style={{ height: ROW_HEIGHT }}
        >
            <GraphCell
                row={row}
                previousColor={rail ? previousColor : undefined}
                hasNext={rail && hasNext}
                geometry={geometry}
                focus={focus}
                fold={fold}
                onToggleFold={onToggleFold}
                onHover={onGraphHover}
            />
            <div
                className="flex h-full min-w-0 flex-1 items-center gap-[5px] pr-2 transition-opacity"
                style={{ opacity: faded ? UNFOCUSED_ROW_OPACITY : 1, minWidth: SUBJECT_MIN_WIDTH }}
            >
                <span className="min-w-0 flex-1 truncate text-[12px] text-dark-50">
                    {commit.subject || "(no subject)"}
                </span>
                {commit.refs.length > 0 && <RefBadges refs={commit.refs} width={refWidth} />}
            </div>
            <div
                className="flex h-full shrink-0 transition-opacity"
                style={{ opacity: faded ? UNFOCUSED_ROW_OPACITY : 1 }}
            >
                {columns.map((column) =>
                    column === "author" ? (
                        <AuthorCell
                            key={column}
                            width={columnWidth(column, authorDisplay)}
                            display={authorDisplay}
                            name={commit.authorName.trim() || "Unknown"}
                            avatar={avatar}
                        />
                    ) : column === "date" ? (
                        <DateCell key={column} authoredAt={commit.authoredAt} />
                    ) : (
                        <ShaCell key={column} sha={commit.sha} />
                    )
                )}
            </div>
        </div>
    );
}

function segmentPath(s: GraphSegment, g: Geometry) {
    const mid = ROW_HEIGHT / 2;
    const top = -ROW_OVERLAP;
    const bottom = ROW_HEIGHT + ROW_OVERLAP;
    const x1 = laneX(g, s.from);
    const x2 = laneX(g, s.to);
    if (s.shape === "incoming") {
        return `M${x1} ${top}C${x1} ${mid * 0.55} ${x2} ${mid * 0.55} ${x2} ${mid}`;
    }
    if (s.shape === "outgoing") {
        return `M${x1} ${mid}C${x1} ${mid * 1.45} ${x2} ${mid * 1.45} ${x2} ${bottom}`;
    }
    if (x1 === x2) return `M${x1} ${top}L${x2} ${bottom}`;
    return `M${x1} ${top}C${x1} ${mid} ${x2} ${mid} ${x2} ${bottom}`;
}

function GraphCell({
    row,
    previousColor,
    hasNext,
    geometry,
    focus,
    fold,
    onToggleFold,
    onHover
}: {
    row: GraphRow;
    previousColor: number | undefined;
    hasNext: boolean;
    geometry: Geometry;
    focus: number | undefined;
    fold: Fold | undefined;
    onToggleFold: (ref: GitHistoryRef) => void;
    onHover: (color: number | undefined) => void;
}) {
    const paint = (id: number) =>
        focus !== undefined && focus !== id ? dimmed(colorOf(id)) : colorOf(id);
    const leave = () => onHover(undefined);
    const mid = ROW_HEIGHT / 2;
    const nodeX = laneX(geometry, geometry.compact ? 0 : row.lane);
    const radius = NODE_RADIUS;
    const color = paint(row.color);

    // The compact rail: each row's half-lines in its node's colour, as zeron joins row centres.
    const lines: { d: string; color: number }[] = geometry.compact
        ? [
              ...(previousColor !== undefined
                  ? [{ d: `M${nodeX} ${-ROW_OVERLAP}L${nodeX} ${mid}`, color: previousColor }]
                  : []),
              ...(hasNext
                  ? [{ d: `M${nodeX} ${mid}L${nodeX} ${ROW_HEIGHT + ROW_OVERLAP}`, color: row.color }]
                  : [])
          ]
        : row.segments.map((s) => ({ d: segmentPath(s, geometry), color: s.color }));
    // The focused path on top.
    lines.sort((a, b) => Number(a.color === focus) - Number(b.color === focus));

    return (
        <div
            className="group/graph relative h-full shrink-0"
            style={{ width: geometry.width }}
            onMouseLeave={leave}
        >
            <svg
                width={geometry.width}
                height={ROW_HEIGHT}
                className="absolute inset-0 overflow-visible"
                aria-hidden
            >
                <g fill="none">
                    {lines.map((line, i) => (
                        <path
                            key={i}
                            d={line.d}
                            stroke={paint(line.color)}
                            strokeWidth={STROKE}
                            className="transition-[stroke] duration-150"
                        />
                    ))}
                </g>
                {row.isHead && (
                    <circle
                        cx={nodeX}
                        cy={mid}
                        r={radius + HEAD_RING_PADDING}
                        fill={PANEL_BG}
                        stroke={color}
                        strokeWidth={1}
                    />
                )}
                <circle cx={nodeX} cy={mid} r={radius} fill={color} className="transition-[fill] duration-150" />
                {/* Wider invisible strokes to hover a path by. */}
                <g fill="none" stroke="transparent" strokeWidth={HIT_WIDTH} pointerEvents="stroke">
                    {lines.map((line, i) => (
                        <path
                            key={i}
                            d={line.d}
                            onMouseEnter={() => onHover(line.color)}
                            onMouseLeave={leave}
                        />
                    ))}
                </g>
                <circle
                    cx={nodeX}
                    cy={mid}
                    r={radius + 5.5}
                    fill="transparent"
                    pointerEvents="all"
                    onMouseEnter={() => onHover(row.color)}
                    onMouseLeave={leave}
                />
            </svg>
            {fold && (
                <FoldButton
                    fold={fold}
                    left={nodeX + NODE_RADIUS + 3}
                    color={colorOf(row.color)}
                    onToggle={onToggleFold}
                />
            )}
        </div>
    );
}

function FoldButton({
    fold,
    left,
    color,
    onToggle
}: {
    fold: Fold;
    left: number;
    color: string;
    onToggle: (ref: GitHistoryRef) => void;
}) {
    const label = fold.folded
        ? `Expand ${fold.ref.label}${fold.hidden ? ` (${fold.hidden} hidden)` : ""}`
        : `Collapse ${fold.ref.label}`;
    const Icon = fold.folded ? ArrowsOutLineVerticalIcon : ArrowsInLineVerticalIcon;
    return (
        <Tooltip>
            <Tooltip.Trigger
                delay={250}
                render={
                    <button
                        type="button"
                        aria-label={label}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle(fold.ref);
                        }}
                        className={cn(
                            "absolute flex size-4 items-center justify-center rounded-full border outline-none transition-opacity",
                            "group-hover/graph:opacity-100 focus-visible:opacity-100",
                            fold.folded ? "opacity-100" : "opacity-0"
                        )}
                        style={{
                            left,
                            top: (ROW_HEIGHT - 16) / 2,
                            borderColor: `color-mix(in srgb, ${color} 32%, transparent)`,
                            background: PANEL_BG,
                            color
                        }}
                    >
                        <Icon className="size-[9px]" weight="bold" />
                    </button>
                }
            />
            <Tooltip.Content side="bottom">{label}</Tooltip.Content>
        </Tooltip>
    );
}

function RefBadges({ refs, width }: { refs: GitHistoryRef[]; width: number }) {
    // Not even one fits whole: the first one truncated, rather than just "+N".
    const count = Math.max(visibleRefCount(refs, width), width >= 48 ? 1 : 0);
    const hidden = refs.slice(count);
    const describe = (r: GitHistoryRef) => `${REF_STYLE[r.kind].label}: ${r.label}`;
    return (
        <div className="flex min-w-0 shrink-0 items-center overflow-hidden" style={{ maxWidth: width, gap: REF_GAP }}>
            {refs.slice(0, count).map((ref) => {
                const { className, Icon } = REF_STYLE[ref.kind];
                return (
                    <Tooltip key={`${ref.kind}:${ref.label}`}>
                        <Tooltip.Trigger
                            delay={350}
                            render={
                                <span
                                    className={cn(
                                        "flex h-[18px] min-w-0 max-w-28 shrink items-center gap-0.5 rounded px-[5px] text-[10px]",
                                        className
                                    )}
                                >
                                    <Icon className="size-2.5 shrink-0 opacity-80" />
                                    <span className="min-w-0 truncate">{ref.label}</span>
                                </span>
                            }
                        />
                        <Tooltip.Content side="bottom" className="font-mono">
                            {describe(ref)}
                        </Tooltip.Content>
                    </Tooltip>
                );
            })}
            {hidden.length > 0 && (
                <Tooltip>
                    <Tooltip.Trigger
                        delay={350}
                        render={<span className="shrink-0 text-[10px] text-dark-250">+{hidden.length}</span>}
                    />
                    <Tooltip.Content side="bottom" className="font-mono">
                        {hidden.map((r) => (
                            <div key={`${r.kind}:${r.label}`}>{describe(r)}</div>
                        ))}
                    </Tooltip.Content>
                </Tooltip>
            )}
        </div>
    );
}

function AuthorCell({
    width,
    display,
    name,
    avatar
}: {
    width: number;
    display: AuthorDisplay;
    name: string;
    avatar: string | undefined;
}) {
    if (display === "name") {
        return (
            <div className="flex h-full items-center truncate pr-2 text-dark-200" style={{ width }}>
                <span className="truncate">{name}</span>
            </div>
        );
    }
    const initial = [...name][0]?.toUpperCase() ?? "?";
    return (
        <div className="flex h-full items-center justify-center" style={{ width }}>
            <Tooltip>
                <Tooltip.Trigger
                    delay={300}
                    render={
                        <span className="flex size-5 items-center justify-center overflow-hidden rounded-full border border-white/[0.12] bg-white/[0.08] text-[9px] text-dark-250">
                            {avatar ? (
                                <img src={avatar} alt="" className="size-full object-cover" draggable={false} />
                            ) : (
                                initial
                            )}
                        </span>
                    }
                />
                <Tooltip.Content side="bottom">{name}</Tooltip.Content>
            </Tooltip>
        </div>
    );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });

function DateCell({ authoredAt }: { authoredAt: string }) {
    const date = new Date(authoredAt);
    const valid = !Number.isNaN(date.getTime());
    return (
        <div className="flex h-full w-[88px] items-center pr-2 text-[10.5px] text-dark-200">
            {valid ? (
                <Tooltip>
                    <Tooltip.Trigger
                        delay={500}
                        render={<span className="truncate">{dateFormat.format(date)}</span>}
                    />
                    <Tooltip.Content side="bottom">{fullDateFormat.format(date)}</Tooltip.Content>
                </Tooltip>
            ) : (
                "—"
            )}
        </div>
    );
}

function ShaCell({ sha }: { sha: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1200);
        return () => window.clearTimeout(timer);
    }, [copied]);
    return (
        <div className="flex h-full w-[74px] items-center pr-1.5">
            <button
                type="button"
                aria-label="Copy the hash"
                onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(sha).then(() => setCopied(true));
                }}
                className={cn(
                    "flex h-6 w-full items-center rounded px-1 font-mono text-[10.5px] outline-none hover:bg-white/[0.07] focus-visible:bg-white/[0.07]",
                    copied ? "text-info" : "text-dark-200"
                )}
            >
                {copied ? "Copied" : sha.slice(0, 7)}
            </button>
        </div>
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

function Notice({ children, tone }: { children: ReactNode; tone?: "warning" }) {
    return (
        <div
            className={cn(
                "flex flex-1 items-center justify-center p-6 text-center text-xs",
                tone === "warning" ? "text-warning/85" : "text-dark-250"
            )}
        >
            {children}
        </div>
    );
}
