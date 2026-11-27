import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import {
    ArrowClockwiseIcon,
    AtIcon,
    CaretRightIcon,
    CopyIcon,
    CopySimpleIcon,
    EyeIcon,
    EyeSlashIcon,
    MagnifyingGlassIcon,
    PencilSimpleIcon,
    TrashIcon,
    XIcon
} from "@phosphor-icons/react";
import type { GitFileState, WorkspaceEntry } from "@/proto";
import { useActiveChat, useChatsStore, workDir } from "@/features/chats";
import { gitMarks, refreshGitStatus, useGitStatus, type GitMark, type GitStatus } from "@/features/git/status";
import { cn } from "@/lib/cn";
import { fuzzyPositions } from "@/lib/fuzzy";
import { baseName } from "@/lib/paths";
import {
    CollapseAllIcon,
    ConfirmDialog,
    ContextMenu,
    FileIcon,
    IconButton,
    useInlineRename,
    useLastNonNull
} from "@/ui";
import { addToChat, copyPath, renameEntry, trashEntry } from "./actions";
import { loadFolder, rankEntries, refreshFiles, useOpenedFolders, useWorkspaceFiles } from "./listing";
import { files, useExpanded, useFilesStore } from "./store";
import { childrenByFolder, nameOf, parentOf, visibleRows, type TreeRow } from "./tree";

/** Search results shown at most. */
const RESULT_LIMIT = 200;

/** Indent per tree level, in px. */
const INDENT = 12;

const rowClass = (selected: boolean) =>
    cn(
        "flex h-6 w-full cursor-pointer select-none items-center gap-1.5 rounded-md pr-2 text-xs outline-none",
        "transition-colors duration-75 focus-visible:ring-1 focus-visible:ring-muted/50",
        selected ? "bg-hover text-text" : "text-text/85 hover:bg-raised hover:text-text"
    );

/** A changed entry's name, tinted by its mark. */
const MARK_TEXT: Record<GitMark, string> = {
    modified: "text-warning",
    added: "text-success",
    conflict: "text-danger"
};

const MARK_DOT: Record<GitMark, string> = {
    modified: "bg-warning",
    added: "bg-success",
    conflict: "bg-danger"
};

/** A changed file's letter at the row's end, and what it stands for. */
const STATE_LETTER: Record<GitFileState, [letter: string, label: string]> = {
    modified: ["M", "Modified"],
    added: ["A", "Added"],
    untracked: ["U", "Untracked"],
    renamed: ["R", "Renamed"],
    deleted: ["D", "Deleted"],
    conflict: ["!", "Conflict"]
};

const NO_MARKS: ReadonlyMap<string, GitMark> = new Map();

/** A folder's uncommitted files and the marks they give the rows. */
type GitMarks = { status: GitStatus | null | undefined; marks: ReadonlyMap<string, GitMark> };

/** The end of a changed row: a file's letter, or a dot for a folder with changes inside. */
function GitBadge({ entry, git }: { entry: WorkspaceEntry; git: GitMarks }) {
    const mark = git.marks.get(entry.path);
    if (!mark) return null;
    const state = entry.dir ? undefined : git.status?.[entry.path];
    if (!state) {
        return (
            <span
                title="Contains changes"
                className={cn("mr-[3px] ml-auto size-1.5 shrink-0 rounded-full opacity-80", MARK_DOT[mark])}
            />
        );
    }
    const [letter, label] = STATE_LETTER[state];
    return (
        <span
            title={label}
            className={cn("ml-auto w-3 shrink-0 text-center text-[10px] font-medium", MARK_TEXT[mark])}
        >
            {letter}
        </span>
    );
}

/** The folder the open chat works in (its worktree, else its folder), or the new-chat view's pick. */
function useRoot(): string {
    const chat = useActiveChat();
    const newChatCwd = useChatsStore((s) => s.newChatCwd);
    return (chat ? workDir(chat) : newChatCwd) ?? "";
}

/**
 * The file panel's content: a search over the chat folder's files, then its
 * tree (or, while searching, the best matches). Listed while `shown`. A
 * right-click on an entry opens its menu: Add to chat, Copy path, Rename
 * (in place, in the tree), Delete (to the trash, once confirmed).
 */
export function FileExplorer({ shown }: { shown: boolean }) {
    const root = useRoot();
    const showIgnored = useFilesStore((s) => s.showIgnored);
    const listed = useWorkspaceFiles(root, shown, showIgnored);
    const opened = useOpenedFolders(root);
    const status = useGitStatus(root, shown);
    const git = useMemo<GitMarks>(() => ({ status, marks: status ? gitMarks(status) : NO_MARKS }), [status]);
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
    /** The entry whose name is being edited, by path. */
    const [renaming, setRenaming] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<WorkspaceEntry | null>(null);

    const startRename = (entry: WorkspaceEntry) => {
        // The field is in the tree.
        files.reveal(root, entry.path);
        files.setQuery("");
        setRenaming(entry.path);
    };

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
            <div className="flex shrink-0 flex-col gap-1 px-2 pt-2 pb-1">
                {/* The folder shown, and the tree's actions. */}
                <div className="flex h-7 min-w-0 items-center gap-0.5 pr-0.5 pl-2">
                    <span
                        className="min-w-0 flex-1 truncate text-xs font-medium text-text/85"
                    >
                        {root ? baseName(root) : "Files"}
                    </span>
                    <IconButton
                        label={showIgnored ? "Hide ignored files" : "Show ignored files"}
                        aria-pressed={showIgnored}
                        disabled={!root}
                        onClick={files.toggleIgnored}
                        className={cn(showIgnored && "bg-hover text-text")}
                    >
                        {showIgnored ? <EyeIcon className="size-3.5" /> : <EyeSlashIcon className="size-3.5" />}
                    </IconButton>
                    <IconButton
                        label="Collapse folders"
                        disabled={!root}
                        onClick={() => files.collapseAll(root)}
                    >
                        <CollapseAllIcon className="size-3.5" />
                    </IconButton>
                    <IconButton
                        label="Refresh"
                        disabled={!root}
                        onClick={() => {
                            void refreshFiles(root, { force: true, ignored: showIgnored });
                            void refreshGitStatus(root);
                        }}
                    >
                        <ArrowClockwiseIcon className="size-3.5" />
                    </IconButton>
                </div>
                <label className="flex h-7 min-w-0 cursor-text items-center gap-1.5 rounded-md bg-raised px-2 transition-colors hover:bg-hover">
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
                    git={git}
                    highlighted={highlighted}
                    onHighlight={setHighlighted}
                    onPick={pickResult}
                    onRename={startRename}
                    onDelete={setDeleting}
                />
            ) : (
                <Tree
                    root={root}
                    entries={entries}
                    git={git}
                    renaming={renaming}
                    onRename={startRename}
                    onRenameEnd={() => setRenaming(null)}
                    onDelete={setDeleting}
                />
            )}
            <DeleteEntryDialog root={root} entry={deleting} onClose={() => setDeleting(null)} />
        </>
    );
}

function Note({ children }: { children: string }) {
    return <div className="px-4 py-6 text-center text-xs text-muted">{children}</div>;
}

/** An entry's right-click menu. */
function EntryMenu({
    root,
    entry,
    onRename,
    onDelete
}: {
    root: string;
    entry: WorkspaceEntry;
    onRename: (entry: WorkspaceEntry) => void;
    onDelete: (entry: WorkspaceEntry) => void;
}) {
    // The composer or the name's field takes the caret; the closing menu mustn't take it back.
    const keepFocus = useRef(false);
    const finalFocus = () => {
        const keep = keepFocus.current;
        keepFocus.current = false;
        return !keep;
    };
    return (
        <ContextMenu.Content finalFocus={finalFocus} className="w-52 min-w-0">
            <ContextMenu.Item
                onClick={() => {
                    keepFocus.current = true;
                    addToChat(entry);
                }}
            >
                <AtIcon />
                Add to chat
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onClick={() => copyPath(root, entry.path)}>
                <CopyIcon />
                Copy path
            </ContextMenu.Item>
            <ContextMenu.Item onClick={() => copyPath(root, entry.path, true)}>
                <CopySimpleIcon />
                Copy relative path
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item
                onClick={() => {
                    keepFocus.current = true;
                    onRename(entry);
                }}
            >
                <PencilSimpleIcon />
                Rename
                <ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
            </ContextMenu.Item>
            <ContextMenu.Item variant="destructive" onClick={() => onDelete(entry)}>
                <TrashIcon />
                Delete…
                <ContextMenu.Shortcut>Del</ContextMenu.Shortcut>
            </ContextMenu.Item>
        </ContextMenu.Content>
    );
}

/** Asks before `entry` goes to the trash. Closed while null. */
function DeleteEntryDialog({
    root,
    entry,
    onClose
}: {
    root: string;
    entry: WorkspaceEntry | null;
    onClose: () => void;
}) {
    const shown = useLastNonNull(entry);
    return (
        <ConfirmDialog
            open={entry !== null}
            title={shown?.dir ? "Delete folder?" : "Delete file?"}
            confirmLabel="Move to trash"
            onConfirm={async () => {
                if (shown) await trashEntry(root, shown);
            }}
            onClose={onClose}
        >
            <p>
                <span className="font-medium break-all text-text">{shown ? nameOf(shown.path) : ""}</span>
                {shown?.dir ? " and everything in it" : ""} will be moved to the trash.
            </p>
        </ConfirmDialog>
    );
}

/**
 * An entry's name in place, editable: Enter or leaving saves, Escape cancels.
 * `byKey` says a key ended it, so the row can take focus back.
 */
function RenameField({
    entry,
    onSubmit,
    onCancel
}: {
    entry: WorkspaceEntry;
    onSubmit: (name: string, byKey: boolean) => void;
    onCancel: (byKey: boolean) => void;
}) {
    const name = nameOf(entry.path);
    const { finish, value, inputProps } = useInlineRename({
        // A file's name up to its extension, which usually stays.
        select: (field) => {
            const dot = entry.dir ? -1 : name.lastIndexOf(".");
            field.setSelectionRange(0, dot > 0 ? dot : name.length);
        },
        onEnter: () => end(true, true),
        onEscape: () => end(false, true),
        onBlur: () => end(true, false)
    });

    const end = (save: boolean, byKey: boolean) =>
        finish(() => {
            const next = value();
            // Blank keeps the current name.
            if (save && next && next !== name) onSubmit(next, byKey);
            else onCancel(byKey);
        });

    return (
        <input
            {...inputProps}
            // The tree's keys and the row's click aren't for the field.
            onKeyDown={(event) => {
                event.stopPropagation();
                inputProps.onKeyDown(event);
            }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
            defaultValue={name}
            aria-label="Name"
            spellCheck={false}
            autoComplete="off"
            className="-ml-1 h-5 min-w-0 flex-1 cursor-text rounded-sm bg-transparent px-1 text-xs text-text outline-none ring-1 ring-border select-text"
        />
    );
}

/**
 * The folder's tree: folders open and close in place; arrows move the pick,
 * as in an editor; F2 renames it and Delete deletes it.
 */
function Tree({
    root,
    entries,
    git,
    renaming,
    onRename,
    onRenameEnd,
    onDelete
}: {
    root: string;
    entries: readonly WorkspaceEntry[];
    git: GitMarks;
    /** The entry whose name is being edited, by path. */
    renaming: string | null;
    onRename: (entry: WorkspaceEntry) => void;
    onRenameEnd: () => void;
    onDelete: (entry: WorkspaceEntry) => void;
}) {
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

    const focusRow = (path: string) => requestAnimationFrame(() => rowEl(path)?.focus());

    const submitRename = async (entry: WorkspaceEntry, name: string, byKey: boolean) => {
        onRenameEnd();
        if (byKey) focusRow(entry.path);
        const to = await renameEntry(root, entry, name);
        // Its row is a new one; back to it unless focus went elsewhere meanwhile.
        const active = document.activeElement;
        if (to && byKey && (active === document.body || treeRef.current?.contains(active))) focusRow(to);
    };

    const cancelRename = (entry: WorkspaceEntry, byKey: boolean) => {
        onRenameEnd();
        if (byKey) focusRow(entry.path);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        // A row's menu is portalled, but its keys still bubble here.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
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
                case "F2":
                    onRename(entry);
                    return true;
                case "Delete":
                    onDelete(entry);
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
                const editing = entry.path === renaming;
                const mark = git.marks.get(entry.path);
                return (
                    <ContextMenu key={entry.path}>
                        <ContextMenu.Trigger
                            role="treeitem"
                            aria-level={depth + 1}
                            aria-expanded={entry.dir ? open : undefined}
                            aria-selected={entry.path === selected}
                            data-path={entry.path}
                            tabIndex={entry.path === cursor ? 0 : -1}
                            onClick={() => activate(row)}
                            onContextMenu={() => files.select(root, entry.path)}
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
                            {editing ? (
                                <RenameField
                                    entry={entry}
                                    onSubmit={(next, byKey) => void submitRename(entry, next, byKey)}
                                    onCancel={(byKey) => cancelRename(entry, byKey)}
                                />
                            ) : (
                                <span
                                    className={cn(
                                        "min-w-0 truncate",
                                        entry.ignored && "opacity-50",
                                        mark && MARK_TEXT[mark]
                                    )}
                                >
                                    {name}
                                </span>
                            )}
                            <GitBadge entry={entry} git={git} />
                        </ContextMenu.Trigger>
                        <EntryMenu root={root} entry={entry} onRename={onRename} onDelete={onDelete} />
                    </ContextMenu>
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
    git,
    highlighted,
    onHighlight,
    onPick,
    onRename,
    onDelete
}: {
    listRef: RefObject<HTMLDivElement | null>;
    root: string;
    query: string;
    results: WorkspaceEntry[];
    git: GitMarks;
    highlighted: number;
    onHighlight: (index: number) => void;
    onPick: (entry: WorkspaceEntry) => void;
    onRename: (entry: WorkspaceEntry) => void;
    onDelete: (entry: WorkspaceEntry) => void;
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
                const mark = git.marks.get(entry.path);
                return (
                    <ContextMenu key={entry.path}>
                        <ContextMenu.Trigger
                            role="option"
                            aria-selected={index === highlighted}
                            data-index={index}
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
                            <span
                                className={cn(
                                    "max-w-[70%] shrink-0 truncate",
                                    entry.ignored && "opacity-50",
                                    mark && MARK_TEXT[mark]
                                )}
                            >
                                <Highlighted text={name} query={query} />
                                {entry.dir && "/"}
                            </span>
                            {folder && <span className="min-w-0 truncate text-muted">{folder}</span>}
                            <GitBadge entry={entry} git={git} />
                        </ContextMenu.Trigger>
                        <EntryMenu root={root} entry={entry} onRename={onRename} onDelete={onDelete} />
                    </ContextMenu>
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
