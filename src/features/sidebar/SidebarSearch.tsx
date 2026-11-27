import { FolderPlusIcon, MagnifyingGlassIcon, NotePencilIcon, XIcon } from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { chats } from "@/features/chats";
import { projects } from "@/features/projects";
import { isTauri } from "@/lib/platform";
import { IconButton } from "@/ui";
import { useSidebarStore } from "./store";

/** The sidebar's head: a search over its chats, then New chat and Add project. */
export function SidebarSearch() {
    const query = useSidebarStore((s) => s.query);
    const setQuery = useSidebarStore((s) => s.setQuery);

    const addProject = async () => {
        const picked = await openDialog({ directory: true, title: "Add a project" });
        if (typeof picked === "string") projects.add(picked);
    };

    return (
        <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
            {/* A label, so clicking the field's padding focuses it too. */}
            <label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-md bg-raised px-2 transition-colors hover:bg-hover">
                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-muted" />
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
                    className="min-w-0 flex-1 bg-transparent text-xs text-text outline-none placeholder:text-muted"
                />
                {query && (
                    <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Clear search"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:text-text focus-visible:text-text"
                    >
                        <XIcon className="size-3" />
                    </button>
                )}
            </label>

            <IconButton
                label="New chat"
                shortcut="newTab"
                onClick={() => chats.startNew()}
                className="size-7 shrink-0 rounded-md"
            >
                <NotePencilIcon className="size-4" />
            </IconButton>
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
