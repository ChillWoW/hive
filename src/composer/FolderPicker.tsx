import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
    DotsThreeIcon,
    FolderIcon,
    FolderOpenIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    TrashIcon
} from "@phosphor-icons/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { projects, useProjects } from "@/projects";
import { folderName } from "./paths";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { Menu, Tooltip, usePortalContainer } from "@/ui";
import {
    chipClassName,
    chipTriggerClassName,
    footerButtonClassName,
    popupClassName,
    rowClassName,
    searchInputClassName
} from "./chip";
import { ProjectIcon } from "./ProjectIcon";

/**
 * The folder a chat works in, as a chip under the composer. In the new-chat
 * view it picks where the next chat runs: a project (`useProjects`), one from
 * the system dialog, or a path typed into the search; whichever it is becomes
 * a project. A chat already started is `locked` to its folder.
 */
export function FolderPicker({
    cwd,
    onChange,
    locked = false
}: {
    cwd: string | null;
    onChange?: (cwd: string | null) => void;
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
    /** Null when the picked project is deleted. */
    onChange?: (cwd: string | null) => void;
}) {
    const container = usePortalContainer();
    const known = useProjects();
    const items = cwd && !known.includes(cwd) ? [...known, cwd] : known;
    const [open, setOpen] = useState(false);
    /** The project whose row menu is open. */
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const typed = query.trim();
    // A typed path that isn't in the list can be used as is.
    const usable = typed.length > 1 && /[\\/]/.test(typed) && !items.includes(typed);

    const pick = (path: string) => {
        setOpen(false);
        projects.add(path);
        onChange?.(path);
    };

    const browse = async () => {
        setOpen(false);
        const picked = await openDialog({
            directory: true,
            defaultPath: cwd ?? undefined,
            title: "Choose a folder"
        });
        if (typeof picked === "string") pick(picked);
    };

    return (
        <Combobox.Root
            items={items}
            value={cwd}
            open={open}
            onOpenChange={(next, details) => {
                // A row's menu takes focus and lives outside the popup; the
                // list stays open under it.
                if (!next && menuFor) {
                    details.cancel();
                    return;
                }
                setOpen(next);
            }}
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
            {/* The full path on hover; quiet while the list is open. */}
            <Tooltip disabled={!cwd || open}>
                <Tooltip.Trigger
                    render={
                        <Combobox.Trigger
                            className={cn(chipTriggerClassName, !cwd && "text-warning")}
                        >
                            <FolderIcon className="size-3.5 shrink-0" />
                            <span className="truncate">
                                {cwd ? folderName(cwd) : "Choose a folder"}
                            </span>
                        </Combobox.Trigger>
                    }
                />
                <Tooltip.Content side="top" align="start">
                    {cwd}
                </Tooltip.Content>
            </Tooltip>

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
                                    className={cn(
                                        rowClassName,
                                        "group/row grid-cols-[0.875rem_1fr_1.25rem] py-1"
                                    )}
                                >
                                    <ProjectIcon
                                        path={path}
                                        selected={path === cwd}
                                        className="size-3.5"
                                    />
                                    <span className="truncate">{folderName(path)}</span>
                                    <ProjectMenu
                                        path={path}
                                        open={menuFor === path}
                                        onOpenChange={(next) => setMenuFor(next ? path : null)}
                                        onDelete={() => {
                                            projects.remove(path);
                                            if (path === cwd) onChange?.(null);
                                        }}
                                    />
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

/**
 * A project row's "⋯" menu, on the right of the row: shown while the row is
 * highlighted or the menu is open. Its presses stay off the row, so opening
 * it doesn't pick the project.
 */
function ProjectMenu({
    path,
    open,
    onOpenChange,
    onDelete
}: {
    path: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDelete: () => void;
}) {
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return (
        <Menu open={open} onOpenChange={onOpenChange}>
            <Menu.Trigger
                aria-label={`Options for ${folderName(path)}`}
                onPointerDown={stop}
                onMouseDown={stop}
                onMouseUp={stop}
                // The row cancels `pointerdown` to keep focus in the search, so no
                // `mousedown` arrives to open the menu the usual way.
                onClick={(event) => {
                    stop(event);
                    onOpenChange(!open);
                }}
                className={cn(
                    "inline-flex size-5 items-center justify-center rounded-sm text-dark-300 outline-none",
                    "transition-[color,background-color,opacity] duration-100",
                    "hover:bg-dark-600 hover:text-dark-50",
                    "data-[popup-open]:bg-dark-600 data-[popup-open]:text-dark-50",
                    "opacity-0 group-data-[highlighted]/row:opacity-100 data-[popup-open]:opacity-100"
                )}
            >
                <DotsThreeIcon className="size-3.5" weight="bold" />
            </Menu.Trigger>
            {/* Portalled, but React events still bubble to the row; a press
                here mustn't pick the project. */}
            <Menu.Content
                side="right"
                align="start"
                sideOffset={8}
                onPointerDown={stop}
                onPointerUp={stop}
                onMouseDown={stop}
                onMouseUp={stop}
                onClick={stop}
                className="w-36 min-w-0"
            >
                <Menu.Item variant="danger" onClick={onDelete}>
                    <TrashIcon className="size-3.5" />
                    Delete
                </Menu.Item>
            </Menu.Content>
        </Menu>
    );
}
