import { EyeIcon, EyeSlashIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTurnEnded } from "@/git/store";
import { useFolderWatch } from "@/lib/folderWatch";
import { onWindowFocus } from "@/lib/windowFocus";
import { useActiveFolder } from "@/rightbar/folders";
import { IconButton } from "@/ui";
import { FileTree } from "./FileTree";
import { useFilesPanelStore } from "./panel";
import { SearchResults } from "./SearchResults";
import { refreshFiles } from "./store";
import { reloadDirs, reloadTree } from "./tree";

/**
 * Re-lists `cwd`'s tree (and its search listing) as entries appear, go or
 * are renamed in its listed folders (a folder watch), and, in case the watch
 * missed something, when the window regains focus or an agent's turn there ends.
 */
function useRefreshOnChange(cwd: string | null, all: boolean) {
    useFolderWatch(cwd, (change) => {
        if (!cwd) return;
        if (change.overflow || change.dirsOverflow) reloadTree(cwd, all, true);
        else if (change.dirs.length > 0) reloadDirs(cwd, all, change.dirs);
    });

    useTurnEnded(cwd, () => {
        if (!cwd) return;
        reloadTree(cwd, all);
        void refreshFiles(cwd, all, true);
    });

    useEffect(() => {
        if (!cwd) return;
        return onWindowFocus(() => reloadTree(cwd, all));
    }, [cwd, all]);
}

/** The file panel: search and the show-all toggle over the folder's files. */
export function FilesPanel() {
    const cwd = useActiveFolder();
    const all = useFilesPanelStore((s) => s.showAll);
    const query = useFilesPanelStore((s) => s.query.trim());
    useRefreshOnChange(cwd, all);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <FilesHeader />
            {!cwd ? (
                <div className="px-3 py-2 text-[11.5px] text-dark-250">
                    Pick a folder to see its files
                </div>
            ) : query ? (
                <SearchResults cwd={cwd} all={all} query={query} />
            ) : (
                <FileTree cwd={cwd} all={all} />
            )}
        </div>
    );
}

/** Search field and the hidden-files eye, in the explorer's header band. */
function FilesHeader() {
    const query = useFilesPanelStore((s) => s.query);
    const setQuery = useFilesPanelStore((s) => s.setQuery);
    const showAll = useFilesPanelStore((s) => s.showAll);
    const toggleShowAll = useFilesPanelStore((s) => s.toggleShowAll);
    const searchFocus = useFilesPanelStore((s) => s.searchFocus);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!searchFocus) return;
        input.current?.focus();
        input.current?.select();
    }, [searchFocus]);
    const label = showAll ? "Hide hidden and ignored files" : "Show all files (even hidden)";

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-y border-dark-600 px-2">
            {/* A label, so clicking the field's padding focuses it too. */}
            <label className="flex h-6 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md bg-white/[0.035] px-2 transition-colors hover:bg-white/[0.055]">
                <MagnifyingGlassIcon className="size-3 shrink-0 text-dark-200" />
                <input
                    ref={input}
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        setQuery("");
                        event.currentTarget.blur();
                    }}
                    placeholder="Search files"
                    aria-label="Search files"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-[11.5px] text-dark-50 outline-none placeholder:text-dark-200"
                />
            </label>

            <IconButton
                label={label}
                onClick={toggleShowAll}
                aria-pressed={showAll}
                className={showAll ? "bg-white/10 text-dark-50" : undefined}
            >
                {showAll ? (
                    <EyeIcon className="size-3.5" />
                ) : (
                    <EyeSlashIcon className="size-3.5" />
                )}
            </IconButton>
        </div>
    );
}
