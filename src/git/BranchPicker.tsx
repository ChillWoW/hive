import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
    CheckIcon,
    CopyIcon,
    DotsThreeIcon,
    GitBranchIcon,
    GitForkIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    TrashIcon
} from "@phosphor-icons/react";
import {
    chipTriggerClassName,
    footerButtonClassName,
    popupClassName,
    rowClassName,
    searchInputClassName
} from "@/composer/chip";
import { cn } from "@/lib/cn";
import type { GitBranch, GitRepo } from "@/proto";
import { timeAgo, useMinuteClock } from "@/sidebar/time";
import { Menu, Tooltip, usePortalContainer } from "@/ui";
import { DeleteBranchDialog, NewBranchDialog } from "./BranchDialogs";
import { errorText, git, useFolderBusy, useGitRepo } from "./store";

const BUSY_NOTE = "An agent is working in this folder. Branches can change once it's done.";

/**
 * The branch `cwd` has checked out, as a chip beside the folder chip (hidden
 * outside a checkout). It opens a list of the local branches, as the folder
 * picker does: pick one to switch to it, type a new name to branch off the
 * current one. Each row's "⋯": New branch from here, Copy name, and Delete
 * for any branch but the checked-out one. While an agent works in the folder
 * the branch can't move.
 */
export function BranchPicker({ cwd }: { cwd: string | null }) {
    const repo = useGitRepo(cwd)?.repo;
    if (!cwd || !repo) return null;
    return <BranchCombobox cwd={cwd} repo={repo} />;
}

type Dialog =
    | { kind: "new"; from: string }
    | { kind: "delete"; branch: GitBranch };

function BranchCombobox({ cwd, repo }: { cwd: string; repo: GitRepo }) {
    const container = usePortalContainer();
    const busy = useFolderBusy(cwd);
    const now = useMinuteClock();
    const [open, setOpen] = useState(false);
    /** The branch whose row menu is open. */
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<Dialog | null>(null);

    const names = repo.branches.map((b) => b.name);
    const byName = new Map(repo.branches.map((b) => [b.name, b]));
    const label = repo.branch ?? repo.commit ?? "No commits";
    /** Where a new branch starts: the checked-out branch, or HEAD's commit. */
    const head = repo.branch ?? repo.commit ?? null;
    const typed = query.trim();
    const matches = names.filter((n) => n.toLowerCase().includes(typed.toLowerCase()));
    const canChange = !busy && !pending;
    const canCreate = typed.length > 0 && !byName.has(typed) && !!repo.commit && canChange;

    const run = async (action: () => Promise<void>) => {
        setPending(true);
        setError(null);
        try {
            await action();
            setOpen(false);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setPending(false);
        }
    };

    const pick = (name: string) => {
        if (name === repo.branch) {
            setOpen(false);
            return;
        }
        if (!canChange) return;
        void run(() => git.switchBranch(cwd, name));
    };

    const createTyped = () => {
        if (!canCreate || !head) return;
        void run(() => git.createBranch(cwd, typed, head));
    };

    const openDialog = (next: Dialog) => {
        setMenuFor(null);
        setOpen(false);
        setDialog(next);
    };

    return (
        <>
            <Combobox.Root
                items={names}
                value={repo.branch ?? null}
                open={open}
                onOpenChange={(next, details) => {
                    // A row's menu takes focus and lives outside the popup; the
                    // list stays open under it.
                    if (!next && menuFor) {
                        details.cancel();
                        return;
                    }
                    setOpen(next);
                    if (next) {
                        setError(null);
                        void git.refresh(cwd);
                    }
                }}
                inputValue={query}
                onInputValueChange={setQuery}
                onValueChange={(name: string | null) => {
                    if (name) pick(name);
                }}
                filter={(name: string, q: string) =>
                    name.toLowerCase().includes(q.trim().toLowerCase())
                }
            >
                <Tooltip disabled={open}>
                    <Tooltip.Trigger
                        render={
                            <Combobox.Trigger className={chipTriggerClassName}>
                                <GitBranchIcon className="size-3.5 shrink-0" />
                                <span className="truncate">{label}</span>
                            </Combobox.Trigger>
                        }
                    />
                    <Tooltip.Content side="top" align="start">
                        {repo.branch ? "Switch branch" : `Detached at ${repo.commit ?? "HEAD"}`}
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
                            aria-label="Switch branch"
                            className={cn(popupClassName, "w-80")}
                        >
                            <div className="flex items-center gap-2 border-b border-dark-600 px-2.5">
                                <MagnifyingGlassIcon className="size-3.5 shrink-0 text-dark-300" />
                                <Combobox.Input
                                    placeholder="Search or name a new branch"
                                    className={searchInputClassName}
                                    onKeyDown={(event) => {
                                        // Nothing listed to pick: Enter makes the branch.
                                        if (event.key === "Enter" && matches.length === 0) {
                                            event.preventDefault();
                                            createTyped();
                                        }
                                    }}
                                />
                            </div>

                            {busy && (
                                <p className="border-b border-dark-600 px-2.5 py-2 text-xs text-warning">
                                    {BUSY_NOTE}
                                </p>
                            )}

                            <Combobox.Empty className="px-2.5 py-3 text-center text-xs text-dark-300 empty:hidden">
                                {names.length ? "No branches match." : "No branches yet."}
                            </Combobox.Empty>

                            <Combobox.List className="hide-scrollbar max-h-72 overflow-y-auto overscroll-contain p-1 empty:hidden">
                                {(name: string) => {
                                    const branch = byName.get(name)!;
                                    return (
                                        <Combobox.Item
                                            key={name}
                                            value={name}
                                            disabled={!branch.current && !canChange}
                                            className={cn(
                                                rowClassName,
                                                "group/row grid-cols-[0.875rem_1fr_auto_1.25rem] py-1"
                                            )}
                                        >
                                            <GitBranchIcon
                                                className={cn(
                                                    "size-3.5",
                                                    branch.current ? "text-dark-50" : "text-dark-300"
                                                )}
                                            />
                                            <span
                                                className={cn(
                                                    "truncate",
                                                    branch.current && "font-medium text-dark-50"
                                                )}
                                            >
                                                {name}
                                            </span>
                                            <BranchMeta branch={branch} now={now} />
                                            <BranchMenu
                                                branch={branch}
                                                canChange={canChange && !!repo.commit}
                                                open={menuFor === name}
                                                onOpenChange={(next) => setMenuFor(next ? name : null)}
                                                onNewBranch={() => openDialog({ kind: "new", from: name })}
                                                onDelete={() => openDialog({ kind: "delete", branch })}
                                            />
                                        </Combobox.Item>
                                    );
                                }}
                            </Combobox.List>

                            {error && (
                                <p className="border-t border-dark-600 px-2.5 py-2 text-xs break-words whitespace-pre-wrap text-danger">
                                    {error}
                                </p>
                            )}

                            <div className="border-t border-dark-600 p-1">
                                {canCreate ? (
                                    <button
                                        type="button"
                                        onClick={createTyped}
                                        className={footerButtonClassName}
                                    >
                                        <PlusIcon className="size-3.5 shrink-0 text-dark-200" />
                                        <span className="truncate">
                                            Create <span className="text-dark-50">{typed}</span>
                                            <span className="text-dark-250"> from {label}</span>
                                        </span>
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        disabled={!canChange || !repo.commit || !head}
                                        onClick={() => head && openDialog({ kind: "new", from: head })}
                                        className={footerButtonClassName}
                                    >
                                        <PlusIcon className="size-3.5 shrink-0 text-dark-200" />
                                        New branch…
                                    </button>
                                )}
                            </div>
                        </Combobox.Popup>
                    </Combobox.Positioner>
                </Combobox.Portal>
            </Combobox.Root>

            <NewBranchDialog
                cwd={cwd}
                from={dialog?.kind === "new" ? dialog.from : null}
                onClose={() => setDialog(null)}
            />
            <DeleteBranchDialog
                cwd={cwd}
                branch={dialog?.kind === "delete" ? dialog.branch : null}
                into={repo.branch ?? repo.commit ?? "HEAD"}
                onClose={() => setDialog(null)}
            />
        </>
    );
}

/** The checked-out branch's check, else how long since its last commit. */
function BranchMeta({ branch, now }: { branch: GitBranch; now: number }) {
    if (branch.current) {
        return <CheckIcon className="size-3.5 text-dark-50" weight="bold" />;
    }
    if (branch.committedAt == null) return <span />;
    return (
        <span className="text-[11px] text-dark-250 tabular-nums">
            {timeAgo(branch.committedAt, now)}
        </span>
    );
}

/**
 * A branch row's "⋯" menu, as on the folder picker's rows: shown while the
 * row is highlighted or the menu is open, and its presses stay off the row
 * so opening it doesn't switch branches.
 */
function BranchMenu({
    branch,
    canChange,
    open,
    onOpenChange,
    onNewBranch,
    onDelete
}: {
    branch: GitBranch;
    canChange: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onNewBranch: () => void;
    onDelete: () => void;
}) {
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return (
        <Menu open={open} onOpenChange={onOpenChange}>
            <Menu.Trigger
                aria-label={`Options for ${branch.name}`}
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
                    "pointer-events-auto inline-flex size-5 items-center justify-center rounded-sm text-dark-300 outline-none",
                    "transition-[color,background-color,opacity] duration-100",
                    "hover:bg-dark-600 hover:text-dark-50",
                    "data-[popup-open]:bg-dark-600 data-[popup-open]:text-dark-50",
                    "opacity-0 group-hover/row:opacity-100 group-data-[highlighted]/row:opacity-100 data-[popup-open]:opacity-100"
                )}
            >
                <DotsThreeIcon className="size-3.5" weight="bold" />
            </Menu.Trigger>
            {/* Portalled, but React events still bubble to the row; a press
                here mustn't switch branches. */}
            <Menu.Content
                side="right"
                align="start"
                sideOffset={8}
                onPointerDown={stop}
                onPointerUp={stop}
                onMouseDown={stop}
                onMouseUp={stop}
                onClick={stop}
                className="w-48 min-w-0"
            >
                <Menu.Item disabled={!canChange} onClick={onNewBranch}>
                    <GitForkIcon className="size-3.5" />
                    New branch from here…
                </Menu.Item>
                <Menu.Item
                    onClick={() => void navigator.clipboard.writeText(branch.name).catch(() => {})}
                >
                    <CopyIcon className="size-3.5" />
                    Copy name
                </Menu.Item>
                {!branch.current && (
                    <>
                        <Menu.Separator />
                        <Menu.Item variant="danger" disabled={!canChange} onClick={onDelete}>
                            <TrashIcon className="size-3.5" />
                            Delete…
                        </Menu.Item>
                    </>
                )}
            </Menu.Content>
        </Menu>
    );
}
