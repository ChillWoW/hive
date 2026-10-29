import {
    EyeIcon,
    EyeSlashIcon,
    MagnifyingGlassIcon
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { iconButtonClassName, Tooltip } from "@/ui";
import { useFilesPanelStore } from "./panel";

/** The file panel: search and the show-all toggle over the folder's files. */
export function FilesPanel() {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <FilesHeader />
        </div>
    );
}

/** Search field and the hidden-files eye, in a band like zeron's explorer header. */
function FilesHeader() {
    const query = useFilesPanelStore((s) => s.query);
    const setQuery = useFilesPanelStore((s) => s.setQuery);
    const showAll = useFilesPanelStore((s) => s.showAll);
    const toggleShowAll = useFilesPanelStore((s) => s.toggleShowAll);
    const label = showAll
        ? "Hide hidden and ignored files"
        : "Show all files (even hidden)";

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-y border-dark-600 px-2">
            {/* A label, so clicking the field's padding focuses it too. */}
            <label className="flex h-6 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md bg-white/[0.035] px-2 transition-colors hover:bg-white/[0.055]">
                <MagnifyingGlassIcon className="size-3 shrink-0 text-dark-200" />
                <input
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

            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <button
                            type="button"
                            onClick={toggleShowAll}
                            aria-label={label}
                            aria-pressed={showAll}
                            className={cn(
                                iconButtonClassName,
                                showAll && "bg-white/10 text-dark-50"
                            )}
                        >
                            {showAll ? (
                                <EyeIcon className="size-3.5" />
                            ) : (
                                <EyeSlashIcon className="size-3.5" />
                            )}
                        </button>
                    }
                />
                <Tooltip.Content side="bottom">{label}</Tooltip.Content>
            </Tooltip>
        </div>
    );
}
