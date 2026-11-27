import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
    ArrowClockwiseIcon,
    CaretRightIcon,
    EyeIcon,
    EyeSlashIcon,
    MagnifyingGlassIcon,
    XIcon
} from "@phosphor-icons/react";
import type { WorkspaceEntry } from "@/proto";
import { useActiveChat, useChatsStore, workDir } from "@/features/chats";
import { cn } from "@/lib/cn";
import { fuzzyPositions } from "@/lib/fuzzy";
import { CollapseAllIcon, FileIcon, IconButton } from "@/ui";
import { loadFolder, rankEntries, refreshFiles, useOpenedFolders, useWorkspaceFiles } from "./listing";
import { files, useExpanded, useFilesStore } from "./store";
import { childrenByFolder, nameOf, parentOf, visibleRows, type TreeRow } from "./tree";

/** Search results shown at most. */
const RESULT_LIMIT = 200;

/** Indent per tree level, in px. */
const INDENT = 12;

const rowClass = (selected: boolean) =>
    cn(
        "flex h-6 w-full cursor-default select-none items-center gap-1.5 rounded-md pr-2 text-xs outline-none",
        "transition-colors duration-75 focus-visible:ring-1 focus-visible:ring-muted/50",
        selected ? "bg-hover text-text" : "text-text/85 hover:bg-raised hover:text-text"
    );

/** The folder the open chat works in (its worktree, else its folder), or the new-chat view's pick. */
function useRoot(): string {
    const chat = useActiveChat();
    const newChatCwd = useChatsStore((s) => s.newChatCwd);
    return (chat ? workDir(chat) : newChatCwd) ?? "";
}

/**
 * The file panel's content: a search over the chat folder's files, then its
 * tree (or, while searching, the best matches). Listed while `shown`.
 */
export function FileExplorer({ shown }: { shown: boolean }) {
    const root = useRoot();
    const showIgnored = useFilesStore((s) => s.showIgnored);
    const listed = useWorkspaceFiles(root, shown, showIgnored);
    const opened = useOpenedFolders(root);
    // With ignored files shown, what's inside the ignored folders opened so far too.
    const entries = useMemo(
        () => {
            if (!listed || !showIgnored) return listed;
            // A folder `.gitignore` stopped hiding is in the listing itself now.
            const known = new Set(listed.map((e) => e.path));
            const inside = Object.values(opened).flat().filter((e) => !known.has(e.path));
            return [...listed, ...inside];
        },
        [listed, showIgnored, opened]
    );
    const query = useFilesStore((s) => s.query);
    const searching = query.trim() !== "";
    const results = useMemo(
        () => (searching && entries ? rankEntries(query.trim(), entries, RESULT_LIMIT) : []),
        [searching, query, entries]
    );
    const [highlighted, setHighlighted] = useState(0);
    const [lastQuery, setLastQuery] = useState(query);
    if (query !== lastQuery) {
        setLastQuery(query);
        setHighlighted(0);
    }
    const resultsRef = useRef<HTMLDivElement>(null);

    const pickResult = (entry: WorkspaceEntry) => {
        if (entry.dir) {
            // A folder shows in the tree, opened.
            files.reveal(root, entry.path);
            files.setFolderOpen(root, entry.path, true);
            files.setQuery("");
        } else {
            files.open(root, entry.path);
        }
    };

    const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
            files.setQuery("");
            event.currentTarget.blur();
            return;
        }
        if (!searching || results.length === 0) return;
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
        if (step) {
            event.preventDefault();
            const next = (highlighted + step + results.length) % results.length;
            setHighlighted(next);
            resultsRef.current
                ?.querySelector(`[data-index="${next}"]`)
                ?.scrollIntoView({ block: "nearest" });
        } else if (event.key === "Enter") {
            event.preventDefault();
            const entry = results[highlighted];
            if (entry) pickResult(entry);
        }
    };

    return (
        <>
            <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
                <label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md bg-raised px-2 transition-colors hover:bg-hover">
                    <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted" />
                    <input
                        type="text"
                        value={query}
                        onChange={(event) => files.setQuery(event.target.value)}
                        onKeyDown={onSearchKey}
                        disabled={!root}
                        placeholder="Search files"
                        aria-label="Search files"
                        spellCheck={false}
                        autoComplete="off"
                        className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => files.setQuery("")}
                            aria-label="Clear search"
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
                        >
                            <XIcon className="size-3" />
                        </button>
                    )}
                </label>
                <IconButton
                    label={showIgnored ? "Hide ignored files" : "Show ignored files"}
                    aria-pressed={showIgnored}
                    disabled={!root}
                    onClick={files.toggleIgnored}
                    className={cn("size-7 rounded-md", showIgnored && "bg-hover text-text")}
                >
                    {showIgnored ? <EyeIcon className="size-4" /> : <EyeSlashIcon className="size-4" />}
                </IconButton>
                <IconButton
                    label="Collapse folders"
                    disabled={!root}
                    onClick={() => files.collapseAll(root)}
                    className="size-7 rounded-md"
                >
                    <CollapseAllIcon className="size-4" />
                </IconButton>
                <IconButton
                    label="Refresh"
                    disabled={!root}
                    onClick={() => void refreshFiles(root, { force: true, ignored: showIgnored })}
                    className="size-7 rounded-md"
                >
                    <ArrowClockwiseIcon className="size-4" />
                </IconButton>
            </div>

            {!root ? (
                <Note>Pick a folder to see its files</Note>
            ) : !entries ? (
                <Note>Listing files…</Note>
            ) : entries.length === 0 ? (
                <Note>No files</Note>
            ) : searching ? (
                <SearchResults
                    listRef={resultsRef}
                    root={root}
                    query={query.trim()}
                    results={results}
                    highlighted={highlighted}
                    onHighlight={setHighlighted}
                    onPick={pickResult}
                />
            ) : (
                <Tree root={root} entries={entries} />
            )}
        </>
    );
}

function Note({ children }: { children: string }) {
    return <div className="px-4 py-6 text-center text-xs text-muted">{children}</div>;
}

/** The folder's tree: folders open and close in place; arrows move the pick, as in an editor. */
function Tree({ root, entries }: { root: string; entries: readonly WorkspaceEntry[] }) {
    const children = useMemo(() => childrenByFolder(entries), [entries]);
    const expandedList = useExpanded(root);
    const expanded = useMemo(() => new Set(expandedList), [expandedList]);
    const rows = useMemo(() => visibleRows(children, expanded), [children, expanded]);
    const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);
    // An open ignored folder wasn't walked into: list it now.
    useEffect(() => {
        for (const path of expandedList) {
            const entry = byPath.get(path);
            if (entry?.dir && entry.ignored) loadFolder(root, path);
        }
    }, [root, expandedList, byPath]);
    const selected = useFilesStore((s) => s.selected[root]);
    const at = rows.findIndex((row) => row.entry.path === selected);
    // The row Tab lands on: the pick while it's shown, else the first.
    const cursor = rows[at >= 0 ? at : 0]?.entry.path;
    const treeRef = useRef<HTMLDivElement>(null);

    const rowEl = (path: string) =>
        treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);

    // Keeps the pick in view, as after revealing it from a search.
    useEffect(() => {
        if (selected) rowEl(selected)?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    const activate = ({ entry }: TreeRow) => {
        if (entry.dir) {
            files.select(root, entry.path);
            files.toggleFolder(root, entry.path);
        } else {
            files.open(root, entry.path);
        }
    };

    const moveTo = (path: string | undefined) => {
        if (path === undefined) return;
        files.select(root, path);
        rowEl(path)?.focus();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const index = Math.max(at, 0);
        const row = rows[index];
        if (!row) return;
        const { entry } = row;
        const handled = (() => {
            switch (event.key) {
                case "ArrowDown":
                    moveTo(rows[Math.min(index + 1, rows.length - 1)]?.entry.path);
                    return true;
                case "ArrowUp":
                    moveTo(rows[Math.max(index - 1, 0)]?.entry.path);
                    return true;
                case "Home":
                    moveTo(rows[0]?.entry.path);
                    return true;
                case "End":
                    moveTo(rows.at(-1)?.entry.path);
                    return true;
                case "ArrowRight":
                    if (!entry.dir) return false;
                    if (row.open) moveTo(rows[index + 1]?.entry.path);
                    else files.setFolderOpen(root, entry.path, true);
                    return true;
                case "ArrowLeft":
                    if (row.open) files.setFolderOpen(root, entry.path, false);
                    else if (row.depth > 0) moveTo(parentOf(entry.path));
                    return true;
                case "Enter":
                case " ":
                    activate(row);
                    return true;
                default:
                    return false;
            }
        })();
        if (handled) event.preventDefault();
    };

    return (
        <div
            ref={treeRef}
            role="tree"
            aria-label="Files"
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-2"
        >
            {rows.map((row) => {
                const { entry, depth, open } = row;
                const name = nameOf(entry.path);
                return (
                    <div
                        key={entry.path}
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-expanded={entry.dir ? open : undefined}
                        aria-selected={entry.path === selected}
                        data-path={entry.path}
                        tabIndex={entry.path === cursor ? 0 : -1}
                        title={entry.path}
                        onClick={() => activate(row)}
                        style={{ paddingLeft: 6 + depth * INDENT }}
                        className={rowClass(entry.path === selected)}
                    >
                        {entry.dir ? (
                            <CaretRightIcon
                                weight="bold"
                                className={cn(
                                    "size-2.5 shrink-0 text-muted transition-transform duration-100",
                                    open && "rotate-90"
                                )}
                            />
                        ) : (
                            <span className="size-2.5 shrink-0" />
                        )}
                        <FileIcon
                            name={name}
                            folder={entry.dir}
                            open={open}
                            className={cn("size-3.5", entry.ignored && "opacity-50")}
                        />
                        <span className={cn("min-w-0 truncate", entry.ignored && "opacity-50")}>{name}</span>
                    </div>
                );
            })}
        </div>
    );
}

/** The best matches for the search, each with its folder; the query's letters in the name stand out. */
function SearchResults({
    listRef,
    root,
    query,
    results,
    highlighted,
    onHighlight,
    onPick
}: {
    listRef: RefObject<HTMLDivElement | null>;
    root: string;
    query: string;
    results: WorkspaceEntry[];
    highlighted: number;
    onHighlight: (index: number) => void;
    onPick: (entry: WorkspaceEntry) => void;
}) {
    const selected = useFilesStore((s) => s.selected[root]);
    if (results.length === 0) return <Note>No matching files</Note>;
    return (
        <div
            ref={listRef}
            role="listbox"
            aria-label="Matching files"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-1 pb-2"
        >
            {results.map((entry, index) => {
                const name = nameOf(entry.path);
                const folder = parentOf(entry.path);
                return (
                    <div
                        key={entry.path}
                        role="option"
                        aria-selected={index === highlighted}
                        data-index={index}
                        title={entry.path}
                        onMouseMove={() => onHighlight(index)}
                        onClick={() => onPick(entry)}
                        className={cn(
                            rowClass(entry.path === selected || index === highlighted),
                            "pl-2"
                        )}
                    >
                        <FileIcon
                            name={name}
                            folder={entry.dir}
                            className={cn("size-3.5", entry.ignored && "opacity-50")}
                        />
                        <span className={cn("max-w-[70%] shrink-0 truncate", entry.ignored && "opacity-50")}>
                            <Highlighted text={name} query={query} />
                            {entry.dir && "/"}
                        </span>
                        {folder && <span className="min-w-0 truncate text-muted">{folder}</span>}
                    </div>
                );
            })}
        </div>
    );
}

/** `text` with the letters `query` matched in it emphasized. */
function Highlighted({ text, query }: { text: string; query: string }) {
    const positions = fuzzyPositions(query, text);
    if (!positions) return text;
    const hits = new Set(positions);
    return text.split("").map((char, i) =>
        hits.has(i) ? (
            <span key={i} className="font-semibold text-accent">
                {char}
            </span>
        ) : (
            char
        )
    );
}
