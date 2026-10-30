import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
    CaretRightIcon,
    ChatCircleIcon,
    CopyIcon,
    PencilSimpleIcon,
    TrashIcon
} from "@phosphor-icons/react";
import type { DirectoryEntry } from "@/proto";
import { cn } from "@/lib/cn";
import { openFileTab } from "@/rightbar/actions";
import { ContextMenu, FileIcon } from "@/ui";
import { addEntryToChat, copyEntryPath, renameTreeEntry } from "./actions";
import { DeleteEntryDialog, type DeleteTarget } from "./DeleteEntryDialog";
import { useFilesPanelStore } from "./panel";
import { dirKey, loadDir, nameOf, useTreeStore, type DirListing } from "./tree";

// Zeron's tree metrics (crates/ui/src/files/tree.rs).
const ROW_HEIGHT = 27;
const INDENT = 14;
const INSET = 8;

type Row =
    | { kind: "entry"; entry: DirectoryEntry; depth: number; expanded: boolean }
    | { kind: "status"; key: string; depth: number; text: string; error?: boolean };

const NO_PATHS: string[] = [];

/**
 * The tree's rows, top to bottom: each listed folder's entries, an expanded
 * folder's own under it. `missing` are the shown folders not listed yet.
 */
function buildRows(
    dirs: Record<string, DirListing>,
    cwd: string,
    all: boolean,
    expanded: Set<string>
) {
    const rows: Row[] = [];
    const missing: string[] = [];
    const walk = (dir: string, depth: number) => {
        const listing = dirs[dirKey(cwd, all, dir)];
        const status = (text: string, error?: boolean) =>
            rows.push({ kind: "status", key: `${dir}\0status`, depth, text, error });
        if (!listing) {
            missing.push(dir);
            return status("Loading…");
        }
        if (!listing.entries) return status(listing.error ?? "Couldn't list this folder", true);
        if (listing.entries.length === 0) return status("Empty folder");
        for (const entry of listing.entries) {
            const open = entry.dir && expanded.has(entry.path);
            rows.push({ kind: "entry", entry, depth, expanded: open });
            if (open) walk(entry.path, depth + 1);
        }
    };
    walk("", 0);
    return { rows, missing };
}

/**
 * `cwd`'s files as a tree, folders listed as they're expanded (as in zeron).
 * A right-click opens zeron's tree menu: Add to chat, Copy path, Rename…
 * (in place; also F2), Delete… (asks first; also the Delete key).
 */
export function FileTree({ cwd, all }: { cwd: string; all: boolean }) {
    const dirs = useTreeStore((s) => s.dirs);
    const expandedPaths = useFilesPanelStore((s) => s.expanded[cwd] ?? NO_PATHS);
    const selected = useFilesPanelStore((s) => s.selected);
    const reveal = useFilesPanelStore((s) => s.reveal);
    const { toggleExpanded, select, clearReveal } = useFilesPanelStore.getState();
    const list = useRef<HTMLDivElement>(null);
    // The entry the menu is for, kept while it animates out.
    const [menuFor, setMenuFor] = useState<DirectoryEntry | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
    // A pick that moves the caret elsewhere; the closing menu mustn't take it back.
    const keepFocus = useRef(false);

    // Another folder's tree drops a rename in progress.
    useEffect(() => setRenaming(null), [cwd]);

    const startRename = (path: string) => {
        select(path);
        setRenaming(path);
    };
    const startDelete = (entry: DirectoryEntry) => {
        select(entry.path);
        setDeleting({ cwd, path: entry.path, dir: entry.dir });
    };

    const { rows, missing } = useMemo(
        () => buildRows(dirs, cwd, all, new Set(expandedPaths)),
        [dirs, cwd, all, expandedPaths]
    );

    useEffect(() => {
        for (const dir of missing) void loadDir(cwd, all, dir);
    }, [missing, cwd, all]);

    // A search pick scrolls to its row once the folders above it are listed.
    useEffect(() => {
        if (!reveal) return;
        const row = list.current?.querySelector(`[data-path="${CSS.escape(reveal)}"]`);
        if (!row) return;
        row.scrollIntoView({ block: "center" });
        clearReveal();
    }, [reveal, rows, clearReveal]);

    const entryAt = (target: EventTarget) => {
        const path = (target as Element).closest?.("[data-path]")?.getAttribute("data-path");
        return rows.find(
            (row): row is Extract<Row, { kind: "entry" }> =>
                row.kind === "entry" && row.entry.path === path
        )?.entry;
    };

    return (
        <>
            <ContextMenu
                onOpenChange={(open) => {
                    if (open) keepFocus.current = false;
                }}
            >
                <ContextMenu.Trigger
                    render={<div />}
                    ref={list}
                    role="tree"
                    aria-label="Files"
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
                    onContextMenu={(event) => {
                        const entry = entryAt(event.target);
                        // Only rows have a menu; the rename field keeps the text one.
                        if (!entry || entry.path === renaming) {
                            event.preventBaseUIHandler();
                            if (!entry) event.preventDefault();
                            return;
                        }
                        select(entry.path);
                        setMenuFor(entry);
                    }}
                >
                    {rows.map((row) => (
                        <div
                            key={row.kind === "entry" ? row.entry.path : row.key}
                            style={{ height: ROW_HEIGHT }}
                            className="relative"
                        >
                            {/* An ancestor's guide runs through each of its rows. */}
                            {Array.from({ length: row.depth }, (_, level) => (
                                <span
                                    key={level}
                                    aria-hidden
                                    style={{ left: INSET + INDENT / 2 + level * INDENT }}
                                    className="absolute inset-y-0 w-px bg-dark-600"
                                />
                            ))}
                            {row.kind === "entry" && row.entry.path === renaming ? (
                                <RenameField
                                    cwd={cwd}
                                    row={row}
                                    onDone={(path, refocus) => {
                                        setRenaming(null);
                                        if (path) select(path);
                                        if (!refocus) return;
                                        // Back on its row, for the keyboard.
                                        requestAnimationFrame(() =>
                                            list.current
                                                ?.querySelector<HTMLElement>(
                                                    `[data-path="${CSS.escape(path ?? row.entry.path)}"]`
                                                )
                                                ?.focus()
                                        );
                                    }}
                                />
                            ) : row.kind === "entry" ? (
                                <TreeRow
                                    row={row}
                                    selected={selected === row.entry.path}
                                    onClick={() => {
                                        select(row.entry.path);
                                        // A folder opens or closes; a file opens in a tab, as in zeron.
                                        if (row.entry.dir) toggleExpanded(cwd, row.entry.path);
                                        else openFileTab(cwd, row.entry.path);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "F2") startRename(row.entry.path);
                                        else if (event.key === "Delete") startDelete(row.entry);
                                        else return;
                                        event.preventDefault();
                                    }}
                                />
                            ) : (
                                <div
                                    style={{ paddingLeft: INSET + (row.depth + 1) * INDENT }}
                                    className={cn(
                                        "flex h-full items-center truncate pr-2 text-[10.5px]",
                                        row.error ? "text-danger" : "text-dark-250"
                                    )}
                                >
                                    {row.text}
                                </div>
                            )}
                        </div>
                    ))}
                </ContextMenu.Trigger>
                <ContextMenu.Content
                    finalFocus={() => {
                        const keep = keepFocus.current;
                        keepFocus.current = false;
                        return !keep;
                    }}
                    className="w-44 min-w-0"
                >
                    {menuFor && (
                        <>
                            <ContextMenu.Item
                                onClick={() => {
                                    keepFocus.current = true;
                                    addEntryToChat(menuFor.path, menuFor.dir);
                                }}
                            >
                                <ChatCircleIcon className="size-3.5" />
                                Add to chat
                            </ContextMenu.Item>
                            <ContextMenu.Item onClick={() => copyEntryPath(cwd, menuFor.path)}>
                                <CopyIcon className="size-3.5" />
                                Copy path
                            </ContextMenu.Item>
                            <ContextMenu.Separator />
                            <ContextMenu.Item
                                onClick={() => {
                                    keepFocus.current = true;
                                    startRename(menuFor.path);
                                }}
                            >
                                <PencilSimpleIcon className="size-3.5" />
                                Rename…
                            </ContextMenu.Item>
                            <ContextMenu.Item variant="danger" onClick={() => startDelete(menuFor)}>
                                <TrashIcon className="size-3.5" />
                                Delete…
                            </ContextMenu.Item>
                        </>
                    )}
                </ContextMenu.Content>
            </ContextMenu>
            <DeleteEntryDialog target={deleting} onClose={() => setDeleting(null)} />
        </>
    );
}

/** The part of a name the rename field selects: a file's stem, a folder's whole name. */
function stemEnd(name: string, dir: boolean) {
    const dot = name.lastIndexOf(".");
    return dir || dot <= 0 ? name.length : dot;
}

/**
 * The row's name in place, editable (zeron's tree rename): Enter renames,
 * Escape or leaving cancels; a refusal stays shown under the field.
 */
function RenameField({
    cwd,
    row,
    onDone
}: {
    cwd: string;
    row: Extract<Row, { kind: "entry" }>;
    /** `refocus`: left by a key, so the row takes the focus back. */
    onDone: (renamedTo: string | null, refocus: boolean) => void;
}) {
    const { entry, depth, expanded } = row;
    const name = nameOf(entry.path);
    const input = useRef<HTMLInputElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const done = useRef(false);

    useEffect(() => {
        // After the menu's own focus handling settles.
        const frame = requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(0, stemEnd(name, entry.dir));
        });
        return () => cancelAnimationFrame(frame);
    }, [name, entry.dir]);

    const finish = (to: string | null, refocus = true) => {
        if (done.current) return;
        done.current = true;
        onDone(to, refocus);
    };

    const submit = async () => {
        const next = input.current?.value.trim() ?? "";
        if (busy) return;
        if (!next || next === name) return finish(null);
        setBusy(true);
        setError(null);
        try {
            finish(await renameTreeEntry(cwd, entry.path, next));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(false);
            input.current?.focus();
        }
    };

    return (
        <div
            style={{ paddingLeft: INSET + depth * INDENT }}
            className="relative flex h-full items-center gap-1 pr-2"
        >
            <span className="size-3.5 shrink-0" />
            <FileIcon name={name} folder={entry.dir} open={expanded} className="size-3.5" />
            <input
                ref={input}
                defaultValue={name}
                aria-label={`New name for ${name}`}
                aria-invalid={!!error}
                spellCheck={false}
                autoComplete="off"
                readOnly={busy}
                onChange={() => setError(null)}
                onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") void submit();
                    else if (event.key === "Escape") finish(null);
                }}
                onBlur={() => !busy && finish(null, false)}
                className={cn(
                    "h-[23px] min-w-0 flex-1 rounded-sm border bg-white/[0.035] px-1 text-[11.5px] text-dark-50 outline-none",
                    error ? "border-danger" : "border-primary-500"
                )}
            />
            {error && (
                <div
                    role="alert"
                    style={{ left: INSET + depth * INDENT + 36 }}
                    className="absolute top-full right-2 z-10 rounded-sm border border-danger/40 bg-dark-850 px-1.5 py-1 text-[10.5px] text-danger shadow-lg shadow-black/40"
                >
                    {error}
                </div>
            )}
        </div>
    );
}

function TreeRow({
    row,
    selected,
    onClick,
    onKeyDown
}: {
    row: Extract<Row, { kind: "entry" }>;
    selected: boolean;
    onClick: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
    const { entry, depth, expanded } = row;
    const name = nameOf(entry.path);
    return (
        <button
            type="button"
            role="treeitem"
            data-path={entry.path}
            aria-selected={selected}
            aria-expanded={entry.dir ? expanded : undefined}
            onClick={onClick}
            onKeyDown={onKeyDown}
            style={{ paddingLeft: INSET + depth * INDENT }}
            className={cn(
                "flex h-full w-full items-center gap-1 pr-2 text-left outline-none",
                "focus-visible:bg-white/[0.055]",
                selected ? "bg-white/10 text-dark-50" : "text-dark-100 hover:bg-white/[0.055]",
                entry.ignored && "opacity-50"
            )}
        >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-dark-250">
                {entry.dir && (
                    <CaretRightIcon
                        weight="bold"
                        className={cn("size-2.75 transition-transform", expanded && "rotate-90")}
                    />
                )}
            </span>
            <FileIcon name={name} folder={entry.dir} open={expanded} className="size-3.5" />
            <span className="min-w-0 truncate text-[11.5px]">{name}</span>
        </button>
    );
}
