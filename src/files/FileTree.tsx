import { useEffect, useMemo, useRef } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { DirectoryEntry } from "@/proto";
import { cn } from "@/lib/cn";
import { openFileTab } from "@/rightbar/actions";
import { FileIcon } from "@/ui";
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

/** `cwd`'s files as a tree, folders listed as they're expanded (as in zeron). */
export function FileTree({ cwd, all }: { cwd: string; all: boolean }) {
    const dirs = useTreeStore((s) => s.dirs);
    const expandedPaths = useFilesPanelStore((s) => s.expanded[cwd] ?? NO_PATHS);
    const selected = useFilesPanelStore((s) => s.selected);
    const reveal = useFilesPanelStore((s) => s.reveal);
    const { toggleExpanded, select, clearReveal } = useFilesPanelStore.getState();
    const list = useRef<HTMLDivElement>(null);

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

    return (
        <div
            ref={list}
            role="tree"
            aria-label="Files"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
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
                    {row.kind === "entry" ? (
                        <TreeRow
                            row={row}
                            selected={selected === row.entry.path}
                            onClick={() => {
                                select(row.entry.path);
                                // A folder opens or closes; a file opens in a tab, as in zeron.
                                if (row.entry.dir) toggleExpanded(cwd, row.entry.path);
                                else openFileTab(cwd, row.entry.path);
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
        </div>
    );
}

function TreeRow({
    row,
    selected,
    onClick
}: {
    row: Extract<Row, { kind: "entry" }>;
    selected: boolean;
    onClick: () => void;
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
