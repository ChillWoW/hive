import { FolderPlusIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { projects } from "@/projects";
import { isTauri } from "@/lib/platform";
import { IconButton } from "@/ui";
import { useSidebarStore } from "./store";

/** The sidebar's top row: a search over its chats, then Add project. */
export function SidebarSearch() {
    const query = useSidebarStore((s) => s.query);
    const setQuery = useSidebarStore((s) => s.setQuery);

    const addProject = async () => {
        const picked = await openDialog({ directory: true, title: "Add a project" });
        if (typeof picked === "string") projects.add(picked);
    };

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 px-2">
            {/* A label, so clicking the field's padding focuses it too. */}
            <label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md bg-white/[0.035] px-2 transition-colors hover:bg-white/[0.055]">
                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-200" />
                <input
                    type="text"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        setQuery("");
                        event.currentTarget.blur();
                    }}
                    placeholder="Search chats"
                    aria-label="Search chats"
                    spellCheck={false}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-xs text-dark-50 outline-none placeholder:text-dark-200"
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Clear search"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-dark-200 outline-none transition-colors hover:text-dark-50 focus-visible:text-dark-50"
                    >
                        <XIcon className="size-3" />
                    </button>
                )}
            </label>

            <IconButton
                label="Add project"
                // No native dialog in a browser-only run.
                disabled={!isTauri}
                onClick={() => void addProject()}
                className="size-7 shrink-0 rounded-md"
            >
                <FolderPlusIcon className="size-4" />
            </IconButton>
        </div>
    );
}
