import { useMemo, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
    FolderIcon,
    FolderOpenIcon,
    MagnifyingGlassIcon,
    PlusIcon
} from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useChatsStore } from "@/chats";
import { folderName } from "./paths";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { Tooltip, usePortalContainer } from "@/ui";
import {
    chipClassName,
    chipTriggerClassName,
    footerButtonClassName,
    popupClassName,
    rowClassName,
    searchInputClassName
} from "./chip";
import { ProjectIcon } from "./ProjectIcon";

/** Every chat's folder, most recently active first, once each. */
function useRecentFolders(): string[] {
    const chats = useChatsStore((s) => s.chats);
    return useMemo(() => [...new Set(chats.map((c) => c.cwd))], [chats]);
}

/**
 * The folder a chat works in, as a chip under the composer. In the new-chat
 * view it picks where the next chat runs: a recent folder, one from the
 * system dialog, or a path typed into the search. A chat already started is
 * `locked` to its folder.
 */
export function FolderPicker({
    cwd,
    onChange,
    locked = false
}: {
    cwd: string | null;
    onChange?: (cwd: string) => void;
    locked?: boolean;
}) {
    if (locked) {
        if (!cwd) return null;
        return (
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <span className={cn(chipClassName, "cursor-default")}>
                            <FolderIcon className="size-3.5 shrink-0" />
                            <span className="truncate">{folderName(cwd)}</span>
                        </span>
                    }
                />
                <Tooltip.Content side="top" align="start">
                    {cwd}
                </Tooltip.Content>
            </Tooltip>
        );
    }
    return <FolderCombobox cwd={cwd} onChange={onChange} />;
}

function FolderCombobox({
    cwd,
    onChange
}: {
    cwd: string | null;
    onChange?: (cwd: string) => void;
}) {
    const container = usePortalContainer();
    const recent = useRecentFolders();
    const items = cwd && !recent.includes(cwd) ? [cwd, ...recent] : recent;
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const typed = query.trim();
    // A typed path that isn't in the list can be used as is.
    const usable = typed.length > 1 && /[\\/]/.test(typed) && !items.includes(typed);

    const pick = (path: string) => {
        setOpen(false);
        onChange?.(path);
    };

    const browse = async () => {
        setOpen(false);
        const picked = await openDialog({
            directory: true,
            defaultPath: cwd ?? undefined,
            title: "Choose a folder"
        });
        if (typeof picked === "string") onChange?.(picked);
    };

    return (
        <Combobox.Root
            items={items}
            value={cwd}
            open={open}
            onOpenChange={setOpen}
            inputValue={query}
            onInputValueChange={setQuery}
            onValueChange={(path: string | null) => {
                if (path) pick(path);
            }}
            itemToStringLabel={(path: string) => folderName(path)}
            filter={(path: string, q: string) =>
                path.toLowerCase().includes(q.trim().toLowerCase())
            }
        >
            <Combobox.Trigger
                className={cn(chipTriggerClassName, !cwd && "text-warning")}
            >
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="truncate">
                    {cwd ? folderName(cwd) : "Choose a folder"}
                </span>
            </Combobox.Trigger>

            <Combobox.Portal container={container ?? undefined}>
                <Combobox.Positioner
                    side="top"
                    align="start"
                    sideOffset={8}
                    collisionPadding={12}
                    className="z-50 outline-none"
                >
                    <Combobox.Popup
                        aria-label="Choose a folder"
                        className={cn(popupClassName, "w-72")}
                    >
                        <div className="flex items-center gap-2 border-b border-dark-600 px-2.5">
                            <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-300" />
                            <Combobox.Input
                                placeholder="Search or paste a path"
                                className={searchInputClassName}
                            />
                        </div>

                        <Combobox.Empty className="px-2.5 py-3 text-center text-xs text-dark-300 empty:hidden">
                            {items.length ? "No folders match." : "No recent folders."}
                        </Combobox.Empty>

                        <Combobox.List className="hide-scrollbar max-h-72 overflow-y-auto overscroll-contain p-1 empty:hidden">
                            {(path: string) => (
                                <Combobox.Item
                                    key={path}
                                    value={path}
                                    className={rowClassName}
                                >
                                    <ProjectIcon
                                        path={path}
                                        selected={path === cwd}
                                        className="size-3.5"
                                    />
                                    <span className="truncate">{folderName(path)}</span>
                                </Combobox.Item>
                            )}
                        </Combobox.List>

                        <div className="border-t border-dark-600 p-1">
                            {usable && (
                                <button
                                    type="button"
                                    onClick={() => pick(typed)}
                                    className={footerButtonClassName}
                                >
                                    <PlusIcon className="size-3.5 shrink-0 text-dark-200" />
                                    <span className="truncate">Use {typed}</span>
                                </button>
                            )}
                            <button
                                type="button"
                                // No native dialog in a browser-only run.
                                disabled={!isTauri}
                                onClick={() => void browse()}
                                className={footerButtonClassName}
                            >
                                <FolderOpenIcon className="size-3.5 shrink-0 text-dark-200" />
                                Browse…
                            </button>
                        </div>
                    </Combobox.Popup>
                </Combobox.Positioner>
            </Combobox.Portal>
        </Combobox.Root>
    );
}
