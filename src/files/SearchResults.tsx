import { useMemo } from "react";
import { FileIcon } from "@/ui";
import { useFilesPanelStore } from "./panel";
import { rankEntries } from "./rank";
import { useWorkspaceFiles } from "./store";
import { nameOf } from "./tree";

/** Rows the search shows at most. */
const LIMIT = 200;

/**
 * The best matches for `query` among all of `cwd`'s files, ranked as the
 * `@` menu ranks them; picking one shows it in the tree.
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
    const revealPath = useFilesPanelStore((s) => s.revealPath);
    const matches = useMemo(
        () => (entries ? rankEntries(query, entries, LIMIT) : []),
        [entries, query]
    );

    if (!entries || matches.length === 0) {
        return (
            <div className="px-3 py-2 text-[11.5px] text-dark-250">
                {entries ? "No matching files" : "Loading…"}
            </div>
        );
    }

    return (
        <div
            role="listbox"
            aria-label="Matching files"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
        >
            {matches.map((entry) => {
                const name = nameOf(entry.path);
                const parent = entry.path.slice(0, entry.path.length - name.length - 1);
                return (
                    <button
                        key={entry.path}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onClick={() => revealPath(cwd, entry.path, entry.dir)}
                        className="flex h-[27px] w-full items-center gap-1.5 px-2 text-left text-dark-100 outline-none hover:bg-white/[0.055] focus-visible:bg-white/[0.055]"
                    >
                        <FileIcon name={name} folder={entry.dir} className="size-3.5" />
                        <span className="max-w-full shrink-0 truncate text-[11.5px]">{name}</span>
                        {parent && (
                            <span className="min-w-0 truncate text-[10.5px] text-dark-250">
                                {parent}
                            </span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
