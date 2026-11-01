import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import {
    CheckIcon,
    CopyIcon,
    GitBranchIcon,
    GitForkIcon,
    PlusIcon,
    TrashIcon
} from "@phosphor-icons/react";
import {
    cardListClassName,
    cardRowDetailClassName,
    cardRowClassName,
    chipClassName,
    chipTriggerClassName,
    rowMetaClassName,
    sideMenuItemClassName
} from "@/ui/chip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { GitBranch, GitRepo } from "@/proto";
import { agoLabel, timeAgo, useMinuteClock } from "@/lib/time";
import { ComboboxCard, ComboboxCardSearch, Menu, RowMenu, Tooltip } from "@/ui";
import { DeleteBranchDialog, NewBranchDialog } from "./BranchDialogs";
import { git, useFolderBusy, useGitAction, useGitRepo } from "./store";

const BUSY_NOTE = "An agent is working in this folder. Branches can change once it's done.";

/** The checked-out branch, else HEAD's commit. */
const headLabel = (repo: GitRepo) => repo.branch ?? repo.commit ?? "No commits";

/** The chip's tooltip: `branch`, or that HEAD is detached. */
const headTooltip = (repo: GitRepo, branch: string) =>
    repo.branch ? branch : `Detached at ${repo.commit ?? "HEAD"}`;

/** The list's first item while the search names a branch that isn't there. */
const CREATE = "\u0000create";

/**
 * The branch `cwd` has checked out, as a chip beside the folder chip (hidden
 * outside a checkout). It opens a card of the local branches, as the folder
 * picker does: pick one to switch to it; a name that isn't listed puts
 * "Create …" at the top, branching off the current one. Each row's "⋯" (a
 * card beside it): New branch from here, Copy name, and Delete for any
 * branch but the checked-out one. While an agent works in the folder the
 * branch can't move, and a branch checked out in another worktree can't be
 * switched to or deleted here.
 *
 * A chat already started is `locked`: the branch shows, but can't change.
 */
export function BranchPicker({ cwd, locked = false }: { cwd: string | null; locked?: boolean }) {
    const repo = useGitRepo(cwd)?.repo;
    if (!cwd || !repo) return null;
    if (locked) {
        return (
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <span className={cn(chipClassName, "cursor-default")}>
                            <GitBranchIcon className="size-3.5 shrink-0" />
                            <span className="truncate">{headLabel(repo)}</span>
                        </span>
                    }
                />
                <Tooltip.Content side="top">{headTooltip(repo, "Branch")}</Tooltip.Content>
            </Tooltip>
        );
    }
    return <BranchCombobox cwd={cwd} repo={repo} />;
}

type Dialog =
    | { kind: "new"; from: string }
    | { kind: "delete"; branch: GitBranch };

function BranchCombobox({ cwd, repo }: { cwd: string; repo: GitRepo }) {
    const busy = useFolderBusy(cwd);
    const now = useMinuteClock();
    const [open, setOpen] = useState(false);
    /** The branch whose row menu is open. */
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const { busy: pending, error, setError, run: runAction } = useGitAction();
    const [dialog, setDialog] = useState<Dialog | null>(null);

    const names = repo.branches.map((b) => b.name);
    const byName = new Map(repo.branches.map((b) => [b.name, b]));
    const label = headLabel(repo);
    const typed = query.trim();
    const canChange = !busy && !pending;
    const canCreate = typed.length > 0 && !byName.has(typed) && !!repo.commit;
    const items = canCreate ? [CREATE, ...names] : names;

    const run = async (action: () => Promise<void>) => {
        if (await runAction(action)) setOpen(false);
    };

    const pick = (name: string) => {
        if (name === CREATE) {
            // Off the checked-out branch, or HEAD's commit.
            const head = repo.branch ?? repo.commit;
            if (canChange && head) void run(() => git.createBranch(cwd, typed, head));
            return;
        }
        if (name === repo.branch) {
            setOpen(false);
            return;
        }
        if (!canChange || byName.get(name)?.worktree) return;
        void run(() => git.switchBranch(cwd, name));
    };

    const openDialog = (next: Dialog) => {
        setMenuFor(null);
        setOpen(false);
        setDialog(next);
    };

    return (
        <>
            <Combobox.Root
                items={items}
                value={repo.branch ?? null}
                // Typing lights the first match, so Enter takes it (or creates).
                autoHighlight
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
                    name === CREATE || name.toLowerCase().includes(q.trim().toLowerCase())
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
                    <Tooltip.Content side="top">
                        {headTooltip(repo, "Switch branch")}
                    </Tooltip.Content>
                </Tooltip>

                <ComboboxCard aria-label="Switch branch" className="w-80">
                    <ComboboxCardSearch placeholder="Search or name a new branch" />

                    {busy && (
                        <p className="border-b border-dark-600 px-2.5 py-2 text-xs text-warning">{BUSY_NOTE}</p>
                    )}

                    <Combobox.Empty className="px-2.5 py-3 text-center text-xs text-dark-250 empty:hidden">
                        {names.length ? "No branches match." : "No branches yet."}
                    </Combobox.Empty>

                    <Combobox.List className={cardListClassName}>
                        {(name: string) => {
                            const branch = byName.get(name);
                            return !branch ? (
                                <Combobox.Item
                                    key={CREATE}
                                    value={CREATE}
                                    disabled={!canChange}
                                    className={cardRowClassName}
                                >
                                    <PlusIcon className="size-3.5 shrink-0 text-dark-250" />
                                    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                        <span className="min-w-0 truncate">
                                            Create {typed}
                                        </span>
                                        <span className="shrink-0 text-[11px] text-dark-250">
                                            from {label}
                                        </span>
                                    </span>
                                </Combobox.Item>
                            ) : (
                                <BranchRow
                                    key={name}
                                    branch={branch}
                                    now={now}
                                    disabled={
                                        !branch.current &&
                                        (!canChange || !!branch.worktree)
                                    }
                                    canChange={canChange && !!repo.commit}
                                    menuOpen={menuFor === name}
                                    onMenuOpenChange={(next) =>
                                        setMenuFor(next ? name : null)
                                    }
                                    onNewBranch={() =>
                                        openDialog({ kind: "new", from: name })
                                    }
                                    onDelete={() =>
                                        openDialog({ kind: "delete", branch })
                                    }
                                />
                            );
                        }}
                    </Combobox.List>

                    {error && (
                        <p className="border-t border-dark-600 px-2.5 py-2 text-xs break-words whitespace-pre-wrap text-danger">
                            {error}
                        </p>
                    )}
                </ComboboxCard>
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

/**
 * A branch: a fork for one checked out in another worktree, its name, how
 * long since its last commit (the check on the checked-out one), and its
 * "⋯" in place of that while it's highlighted.
 */
function BranchRow({
    branch,
    now,
    disabled,
    canChange,
    menuOpen,
    onMenuOpenChange,
    onNewBranch,
    onDelete
}: {
    branch: GitBranch;
    now: number;
    disabled: boolean;
    canChange: boolean;
    menuOpen: boolean;
    onMenuOpenChange: (open: boolean) => void;
    onNewBranch: () => void;
    onDelete: () => void;
}) {
    const Icon = branch.worktree ? GitForkIcon : GitBranchIcon;
    const detail = branch.worktree
        ? "Checked out in another worktree"
        : branch.committedAt != null
          ? `Last commit ${agoLabel(branch.committedAt, now)}`
          : null;
    return (
        <Combobox.Item value={branch.name} disabled={disabled} className={cardRowClassName}>
            <Icon
                className={cn(
                    "size-3.5 shrink-0",
                    branch.current ? "text-dark-50" : "text-dark-250"
                )}
            />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span
                    className={cn("max-w-full shrink-0 truncate", branch.current && "text-dark-50")}
                >
                    {branch.name}
                </span>
                {detail && <span className={cardRowDetailClassName}>{detail}</span>}
            </span>
            <span className={cn(rowMetaClassName, menuOpen && "hidden")}>
                {branch.current ? (
                    <CheckIcon className="size-3.5 text-dark-50" weight="bold" />
                ) : (
                    branch.committedAt != null && (
                        <span className="text-[11px] text-dark-250 tabular-nums">
                            {timeAgo(branch.committedAt, now)}
                        </span>
                    )
                )}
            </span>
            <BranchMenu
                branch={branch}
                canChange={canChange}
                open={menuOpen}
                onOpenChange={onMenuOpenChange}
                onNewBranch={onNewBranch}
                onDelete={onDelete}
            />
        </Combobox.Item>
    );
}

/** A branch row's "⋯" menu, as on the folder picker's rows. */
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
    return (
        <RowMenu label={`Options for ${branch.name}`} open={open} onOpenChange={onOpenChange}>
            <Menu.Item
                disabled={!canChange}
                onClick={onNewBranch}
                className={sideMenuItemClassName}
            >
                <PlusIcon className="size-3.5" />
                New branch from here…
            </Menu.Item>
            <Menu.Item
                onClick={() => void copyText(branch.name)}
                className={sideMenuItemClassName}
            >
                <CopyIcon className="size-3.5" />
                Copy name
            </Menu.Item>
            {!branch.current && (
                <>
                    <Menu.Separator />
                    <Menu.Item
                        variant="danger"
                        // Git won't delete a branch another worktree has out.
                        disabled={!canChange || !!branch.worktree}
                        onClick={onDelete}
                        className={sideMenuItemClassName}
                    >
                        <TrashIcon className="size-3.5" />
                        Delete…
                    </Menu.Item>
                </>
            )}
        </RowMenu>
    );
}
