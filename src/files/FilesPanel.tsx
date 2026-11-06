import {
    ArrowsInLineVerticalIcon,
    EyeIcon,
    EyeSlashIcon,
    ListMagnifyingGlassIcon,
    MagnifyingGlassIcon,
    TextAaIcon
} from "@phosphor-icons/react";
import { useEffect, useRef, type ReactNode } from "react";
import type { TextSearchOptions } from "@/proto";
import { useTurnEnded } from "@/git/store";
import { cn } from "@/lib/cn";
import { useFolderWatch } from "@/lib/folderWatch";
import { onWindowFocus } from "@/lib/windowFocus";
import { useActiveFolder } from "@/rightbar/folders";
import { IconButton } from "@/ui";
import { FileTree } from "./FileTree";
import { useFilesPanelStore } from "./panel";
import { SearchResults } from "./SearchResults";
import { TextResults } from "./TextResults";
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
    const mode = useFilesPanelStore((s) => s.mode);
    // Text search looks for exactly what's typed, spaces included.
    const text = useFilesPanelStore((s) => s.query);
    useRefreshOnChange(cwd, all);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <FilesHeader cwd={cwd} />
            {!cwd ? (
                <div className="px-3 py-2 text-[11.5px] text-dark-250">
                    Pick a folder to see its files
                </div>
            ) : query && mode === "text" ? (
                <TextResults cwd={cwd} all={all} query={text} />
            ) : query ? (
                <SearchResults cwd={cwd} all={all} query={query} />
            ) : (
                <FileTree cwd={cwd} all={all} />
            )}
        </div>
    );
}

const NO_PATHS: string[] = [];

/** Search field, the hidden-files eye and collapse all, in the explorer's header band. */
function FilesHeader({ cwd }: { cwd: string | null }) {
    const query = useFilesPanelStore((s) => s.query);
    const anyExpanded = useFilesPanelStore(
        (s) => (cwd ? (s.expanded[cwd] ?? NO_PATHS) : NO_PATHS).length > 0
    );
    const collapseAll = useFilesPanelStore((s) => s.collapseAll);
    const setQuery = useFilesPanelStore((s) => s.setQuery);
    const showAll = useFilesPanelStore((s) => s.showAll);
    const toggleShowAll = useFilesPanelStore((s) => s.toggleShowAll);
    const searchFocus = useFilesPanelStore((s) => s.searchFocus);
    const mode = useFilesPanelStore((s) => s.mode);
    const setMode = useFilesPanelStore((s) => s.setMode);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!searchFocus) return;
        input.current?.focus();
        input.current?.select();
    }, [searchFocus]);
    const label = showAll ? "Hide hidden and ignored files" : "Show all files (even hidden)";
    const textMode = mode === "text";
    const placeholder = textMode ? "Search text in files" : "Search files";

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
                        if (event.key === "Escape") {
                            setQuery("");
                            event.currentTarget.blur();
                            return;
                        }
                        if (textMode || !query.trim()) return;
                        // Into the file name results: ↓ focuses the first, Enter opens it.
                        const first = document.querySelector<HTMLElement>(
                            "[data-file-result]"
                        );
                        if (!first) return;
                        if (event.key === "ArrowDown") first.focus();
                        else if (event.key === "Enter") first.click();
                        else return;
                        event.preventDefault();
                    }}
                    data-files-search=""
                    placeholder={placeholder}
                    aria-label={placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-[11.5px] text-dark-50 outline-none placeholder:text-dark-200"
                />
                {textMode && <TextOptions />}
            </label>

            <IconButton
                label={textMode ? "Search file names" : "Search text in files"}
                shortcut={textMode ? "searchFiles" : "searchInFiles"}
                onClick={() => {
                    setMode(textMode ? "files" : "text");
                    input.current?.focus();
                }}
                aria-pressed={textMode}
                className={textMode ? "bg-white/10 text-dark-50" : undefined}
            >
                <ListMagnifyingGlassIcon className="size-3.5" />
            </IconButton>

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

            {/* Only while the tree is shown with folders open. */}
            {cwd && anyExpanded && !query.trim() && (
                <IconButton label="Collapse all folders" onClick={() => collapseAll(cwd)}>
                    <ArrowsInLineVerticalIcon className="size-3.5" />
                </IconButton>
            )}
        </div>
    );
}

/** The text search's toggles, inside the field: case, whole word, regex. */
function TextOptions() {
    const options = useFilesPanelStore((s) => s.textOptions);
    const toggle = useFilesPanelStore((s) => s.toggleTextOption);
    const option = (key: keyof TextSearchOptions, label: string, glyph: ReactNode) => (
        <IconButton
            label={label}
            aria-pressed={options[key]}
            // Clicking keeps the caret in the field.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
                event.preventDefault();
                toggle(key);
            }}
            className={cn(
                "size-[18px] rounded text-dark-250",
                options[key] && "bg-info/20 text-info hover:bg-info/25 hover:text-info"
            )}
        >
            {glyph}
        </IconButton>
    );
    return (
        <span className="-mr-1.5 flex shrink-0 items-center gap-px">
            {option("caseSensitive", "Match case", <TextAaIcon className="size-3.5" />)}
            {option(
                "wholeWord",
                "Match whole word",
                <span className="text-[10px] leading-none font-semibold underline underline-offset-2">
                    ab
                </span>
            )}
            {option(
                "regex",
                "Use regular expression",
                <span className="font-mono text-[10.5px] leading-none font-semibold">.*</span>
            )}
        </span>
    );
}
