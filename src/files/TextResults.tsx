import { CaretRightIcon } from "@phosphor-icons/react";
import { memo, useState } from "react";
import type { TextMatch, TextSearchFile } from "@/proto";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import { openFileTab } from "@/rightbar/actions";
import { FileIcon } from "@/ui";
import { useFilesPanelStore } from "./panel";
import { useTextSearch } from "./textSearch";

const status = "px-3 py-2 text-[11.5px] text-dark-250";

/**
 * The file panel's search in file contents: each file with matches (folded
 * on click), its matching lines under it; a line opens the file there with
 * the match selected.
 */
export function TextResults({ cwd, all, query }: { cwd: string; all: boolean; query: string }) {
    const options = useFilesPanelStore((s) => s.textOptions);
    const { result, error, searching } = useTextSearch(cwd, query, options, all);
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());

    if (error) return <div className={cn(status, "text-danger")}>{error}</div>;
    if (!result) return <div className={status}>Searching…</div>;
    if (result.files.length === 0) {
        return <div className={status}>{searching ? "Searching…" : "No results"}</div>;
    }

    const lines = result.files.reduce((sum, file) => sum + file.matches.length, 0);
    const toggle = (path: string) =>
        setFolded((prev) => {
            const next = new Set(prev);
            if (!next.delete(path)) next.add(path);
            return next;
        });

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div
                className={cn(
                    "flex h-6 shrink-0 items-center gap-1 px-3 text-[10.5px] text-dark-250 transition-opacity",
                    searching && "opacity-60"
                )}
            >
                <span className="min-w-0 truncate">
                    {lines.toLocaleString()} {lines === 1 ? "line" : "lines"} in{" "}
                    {result.files.length.toLocaleString()}{" "}
                    {result.files.length === 1 ? "file" : "files"}
                    {result.truncated && " · more not shown, refine the search"}
                </span>
            </div>
            <div
                role="tree"
                aria-label="Text search results"
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-1"
            >
                {result.files.map((file) => (
                    <FileResults
                        key={file.path}
                        cwd={cwd}
                        file={file}
                        open={!folded.has(file.path)}
                        onToggle={toggle}
                    />
                ))}
            </div>
        </div>
    );
}

const FileResults = memo(function FileResults({
    cwd,
    file,
    open,
    onToggle
}: {
    cwd: string;
    file: TextSearchFile;
    open: boolean;
    onToggle: (path: string) => void;
}) {
    const name = baseName(file.path);
    const parent = file.path.slice(0, file.path.length - name.length - 1);
    return (
        <div role="treeitem" aria-expanded={open} style={{ contentVisibility: "auto" }}>
            <button
                type="button"
                onClick={() => onToggle(file.path)}
                className="group flex h-[24px] w-full items-center gap-1.5 pr-2 pl-1.5 text-left text-dark-100 outline-none hover:bg-white/[0.055] focus-visible:bg-white/[0.055]"
            >
                <CaretRightIcon
                    weight="bold"
                    className={cn(
                        "size-2.5 shrink-0 text-dark-250 transition-transform",
                        open && "rotate-90"
                    )}
                />
                <FileIcon name={name} className="size-3.5" />
                <span className="max-w-full shrink-0 truncate text-[11.5px]">{name}</span>
                {parent && (
                    <span className="min-w-0 truncate text-[10.5px] text-dark-250">{parent}</span>
                )}
                <span className="ml-auto shrink-0 rounded-full bg-white/[0.07] px-1.5 text-[10px] leading-4 text-dark-100 tabular-nums">
                    {file.matches.length}
                </span>
            </button>
            {open && (
                <div role="group">
                    {file.matches.map((match) => (
                        <MatchRow key={match.line} cwd={cwd} path={file.path} match={match} />
                    ))}
                </div>
            )}
        </div>
    );
});

function MatchRow({ cwd, path, match }: { cwd: string; path: string; match: TextMatch }) {
    const [first] = match.ranges;
    return (
        <button
            type="button"
            role="treeitem"
            onClick={() =>
                openFileTab(cwd, path, {
                    line: match.line,
                    column: match.previewOffset + (first?.[0] ?? 0) + 1,
                    length: first ? first[1] - first[0] : 0
                })
            }
            className="flex h-[22px] w-full items-center gap-2 pr-2 pl-[30px] text-left outline-none hover:bg-white/[0.055] focus-visible:bg-white/[0.055]"
        >
            <span className="min-w-0 flex-1 overflow-hidden text-[11.5px] text-ellipsis whitespace-pre text-dark-200">
                <Highlighted text={match.preview} ranges={match.ranges} />
            </span>
            <span className="shrink-0 text-[10px] text-dark-300 tabular-nums">{match.line}</span>
        </button>
    );
}

/** `text` with its `ranges` (UTF-16 offsets, in order) marked. */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
    const parts = [];
    let at = 0;
    for (const [start, end] of ranges) {
        if (start < at) continue;
        if (start > at) parts.push(text.slice(at, start));
        parts.push(
            <mark key={start} className="rounded-[2px] bg-warning/25 text-dark-50">
                {text.slice(start, end)}
            </mark>
        );
        at = end;
    }
    if (at < text.length) parts.push(text.slice(at));
    return <>{parts}</>;
}
