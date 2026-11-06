import { memo, useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { WorkspaceEntry } from "@/proto";
import { cn } from "@/lib/cn";
import { fuzzyPositions } from "@/lib/fuzzy";
import { baseName } from "@/lib/paths";
import { openFileTab } from "@/rightbar/actions";
import { FileIcon } from "@/ui";
import { markColor, marksFor, useGitMarks } from "./gitStatus";
import { useFilesPanelStore } from "./panel";
import { rankEntries } from "./rank";
import { useWorkspaceFiles } from "./store";

/** Rows the search shows at most. */
const LIMIT = 200;

const status = "px-3 py-2 text-[11.5px] text-dark-250";

/**
 * The best matches for `query` among all of `cwd`'s files, ranked as the
 * `@` menu ranks them, the matched characters marked; picking one shows it in
 * the tree. ↓ from the search field steps in, ↑ at the top goes back.
 */
export function SearchResults({
    cwd,
    all,
    query
}: {
    cwd: string;
    all: boolean;
    query: string;
}) {
    const entries = useWorkspaceFiles(cwd, true, all);
    const marks = useGitMarks(cwd);
    const matches = useMemo(
        () => (entries ? rankEntries(query, entries, LIMIT + 1) : []),
        [entries, query]
    );

    if (!entries) return <div className={status}>Loading…</div>;
    if (matches.length === 0) return <div className={status}>No matching files</div>;

    const more = matches.length > LIMIT;
    const shown = more ? matches.slice(0, LIMIT) : matches;

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div
                role="listbox"
                aria-label="Matching files"
                onKeyDown={stepThrough}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
            >
                {shown.map((entry) => (
                    <ResultRow
                        key={entry.path}
                        cwd={cwd}
                        entry={entry}
                        query={query}
                        git={marksFor(marks, entry.path)}
                    />
                ))}
                {more && (
                    <div className="px-3 pt-1.5 pb-1 text-[10.5px] text-dark-300">
                        First {LIMIT} shown · refine the search
                    </div>
                )}
            </div>
        </div>
    );
}

/** ↑↓ / Home / End between the result rows; ↑ from the first back to the field. */
function stepThrough(event: KeyboardEvent<HTMLDivElement>) {
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-file-result]")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | null | undefined;
    if (event.key === "ArrowDown") next = rows[Math.min(at + 1, rows.length - 1)];
    else if (event.key === "ArrowUp")
        next =
            at <= 0
                ? document.querySelector<HTMLElement>("[data-files-search]")
                : rows[at - 1];
    else if (event.key === "Home") next = rows[0];
    else if (event.key === "End") next = rows.at(-1);
    else return;
    event.preventDefault();
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
}

/**
 * Where the query's characters fall: in the name when it matches there
 * (what people type), else across the whole path. Offsets into the path.
 */
function matchedOffsets(query: string, path: string, name: string): Set<number> {
    const start = path.length - name.length;
    const inName = fuzzyPositions(query, name);
    if (inName) return new Set(inName.map((i) => i + start));
    return new Set(fuzzyPositions(query, path) ?? []);
}

/** `text` (starting at `offset` in the path) with the matched characters marked. */
function marked(text: string, offset: number, hits: Set<number>): ReactNode[] {
    const parts: ReactNode[] = [];
    let run = "";
    let runHit = false;
    const flush = (at: number) => {
        if (!run) return;
        parts.push(
            runHit ? (
                <span key={at} className="text-info">
                    {run}
                </span>
            ) : (
                run
            )
        );
        run = "";
    };
    for (let i = 0; i < text.length; i++) {
        const hit = hits.has(offset + i);
        if (hit !== runHit) {
            flush(i);
            runHit = hit;
        }
        run += text[i];
    }
    flush(text.length);
    return parts;
}

const ResultRow = memo(function ResultRow({
    cwd,
    entry,
    query,
    git
}: {
    cwd: string;
    entry: WorkspaceEntry;
    query: string;
    git: number;
}) {
    const revealPath = useFilesPanelStore((s) => s.revealPath);
    const name = baseName(entry.path);
    const parent = entry.path.slice(0, entry.path.length - name.length - 1);
    const hits = matchedOffsets(query, entry.path, name);
    const color = markColor(git);

    return (
        <button
            type="button"
            role="option"
            aria-selected={false}
            data-file-result=""
            onClick={() => {
                revealPath(cwd, entry.path, entry.dir);
                if (!entry.dir) openFileTab(cwd, entry.path);
            }}
            className="flex h-[27px] w-full items-center gap-1.5 pr-3 pl-2.5 text-left text-dark-100 outline-none hover:bg-white/[0.055] focus-visible:bg-white/10 focus-visible:text-dark-50"
        >
            <FileIcon name={name} folder={entry.dir} className="size-3.5 shrink-0" />
            <span className={cn("max-w-full shrink-0 truncate text-[11.5px]", color)}>
                {marked(name, entry.path.length - name.length, hits)}
            </span>
            {parent && (
                <span
                    dir="rtl"
                    className="ml-1 min-w-0 truncate text-left text-[10.5px] text-dark-300"
                >
                    {/* rtl truncates from the start, so the nearest folders stay in view. */}
                    <bdi>{marked(parent, 0, hits)}</bdi>
                </span>
            )}
        </button>
    );
});
