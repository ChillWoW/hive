import { useState } from "react";
import { CheckIcon, CopyIcon, GitBranchIcon, GitForkIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { agoLabel, timeAgo, useMinuteClock } from "@/lib/time";
import type { GitBranch, GitRepo } from "@/proto";
import { Menu, RowMenu } from "@/ui";
import { cardListClassName, cardRowDetailClassName, rowMetaClassName, sideMenuItemClassName } from "@/ui/chip";
import { CardSearch, useRows } from "./list";
import { git, useFolderBusy, useGitAction } from "./store";

export type BranchDialog = { kind: "new"; from: string } | { kind: "delete"; branch: GitBranch };

/** The list's first row while the search names a branch that isn't there. */
const CREATE = "\u0000create";

/**
 * `cwd`'s local branches under a search. Picking one switches to it; a name
 * that isn't listed puts "Create …" on top, branching off the current one.
 * With `base`, a branch is picked as what a new worktree starts from instead
 * (null for the checked-out one) and the checkout stays as it is.
 *
 * Each row's "⋯": New branch from here, Copy name, and Delete for any branch
 * but the checked-out one. While an agent works in the folder the branch
 * can't move, and one checked out in another worktree can't be switched to
 * or deleted here.
 */
export function BranchList({
    cwd,
    repo,
    base,
    menuFor,
    onMenuChange,
    onDialog,
    onDone,
    onEscape
}: {
    cwd: string;
    repo: GitRepo;
    base?: { value: string; onChange: (base: string | null) => void };
    /** The row whose "⋯" menu is open. */
    menuFor: string | null;
    onMenuChange: (key: string | null) => void;
    onDialog: (dialog: BranchDialog) => void;
    /** A branch was picked. */
    onDone: () => void;
    /** Escape in the search, when it shouldn't close the whole picker. */
    onEscape?: () => void;
}) {
    const now = useMinuteClock();
    const busy = useFolderBusy(cwd);
    const { busy: pending, error, run: runAction } = useGitAction();
    const [query, setQuery] = useState("");

    const typed = query.trim();
    const q = typed.toLowerCase();
    const byName = new Map(repo.branches.map((b) => [b.name, b]));
    const head = repo.branch ?? repo.commit;
    const canChange = !busy && !pending;
    const creatable = !base && !!head && typed.length > 0 && !/\s/.test(typed) && !byName.has(typed);
    const keys = [
        ...(creatable ? [CREATE] : []),
        ...repo.branches.map((b) => b.name).filter((name) => name.toLowerCase().includes(q))
    ];
    const chosen = base?.value ?? repo.branch ?? null;
    const rows = useRows(keys, chosen, q.length > 0);

    const run = async (action: () => Promise<void>) => {
        if (await runAction(action)) onDone();
    };

    const pick = (name: string) => {
        if (name === CREATE) {
            if (canChange && head) void run(() => git.createBranch(cwd, typed, head));
            return;
        }
        if (base) {
            base.onChange(name === repo.branch ? null : name);
            onDone();
            return;
        }
        if (name === repo.branch) {
            onDone();
            return;
        }
        if (!canChange || byName.get(name)?.worktree) return;
        void run(() => git.switchBranch(cwd, name));
    };

    return (
        <>
            <CardSearch
                value={query}
                onChange={(next) => {
                    setQuery(next);
                    rows.reset();
                }}
                onKeyDown={(event) => {
                    if (rows.onKeyDown(event, pick)) return;
                    if (event.key === "Escape" && onEscape) {
                        event.preventDefault();
                        event.stopPropagation();
                        onEscape();
                    }
                }}
                placeholder={base ? "Search branches" : "Search or name a new branch"}
                controls={rows.listId}
                activeId={rows.activeId}
            />

            {!keys.length && (
                <p className="px-2.5 py-3 text-center text-xs text-muted/75">
                    {repo.branches.length ? "No branches match." : "No branches yet."}
                </p>
            )}

            <div id={rows.listId} role="listbox" aria-label="Branches" className={cardListClassName}>
                {keys.map((name) => {
                    const branch = byName.get(name);
                    if (!branch) {
                        return (
                            <div key={CREATE} {...rows.row(CREATE, false, () => pick(CREATE), !canChange)}>
                                <PlusIcon className="size-3.5 shrink-0 text-muted" />
                                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                    <span className="min-w-0 truncate">Create {typed}</span>
                                    <span className="shrink-0 text-[11px] text-muted/75">from {head}</span>
                                </span>
                            </div>
                        );
                    }
                    const selected = name === chosen;
                    // A worktree can start from any branch; switching can't take one that's out elsewhere.
                    const disabled = !base && !branch.current && (!canChange || !!branch.worktree);
                    const Icon = branch.worktree ? GitForkIcon : GitBranchIcon;
                    const detail = branch.worktree
                        ? "In another worktree"
                        : branch.committedAt != null
                          ? `Last commit ${agoLabel(branch.committedAt, now)}`
                          : null;
                    return (
                        <div key={name} {...rows.row(name, selected, () => pick(name), disabled)}>
                            <Icon className={cn("size-3.5 shrink-0", selected ? "text-text" : "text-muted")} />
                            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                <span className="max-w-full shrink-0 truncate font-medium">{name}</span>
                                {detail && <span className={cardRowDetailClassName}>{detail}</span>}
                            </span>
                            <span className={cn(rowMetaClassName, menuFor === name && "hidden")}>
                                {selected ? (
                                    <CheckIcon className="size-3" weight="bold" />
                                ) : (
                                    branch.committedAt != null && (
                                        <span className="text-[11px] text-muted/75 tabular-nums">
                                            {timeAgo(branch.committedAt, now)}
                                        </span>
                                    )
                                )}
                            </span>
                            <RowMenu
                                label={`Options for ${name}`}
                                open={menuFor === name}
                                onOpenChange={(next) => onMenuChange(next ? name : null)}
                            >
                                <Menu.Item
                                    disabled={!canChange || !repo.commit}
                                    onClick={() => onDialog({ kind: "new", from: name })}
                                    className={sideMenuItemClassName}
                                >
                                    <PlusIcon />
                                    New branch from here…
                                </Menu.Item>
                                <Menu.Item onClick={() => void copyText(name)} className={sideMenuItemClassName}>
                                    <CopyIcon />
                                    Copy name
                                </Menu.Item>
                                {!branch.current && (
                                    <>
                                        <Menu.Separator />
                                        <Menu.Item
                                            variant="destructive"
                                            // Git won't delete a branch another worktree has out.
                                            disabled={!canChange || !!branch.worktree}
                                            onClick={() => onDialog({ kind: "delete", branch })}
                                            className={sideMenuItemClassName}
                                        >
                                            <TrashIcon />
                                            Delete…
                                        </Menu.Item>
                                    </>
                                )}
                            </RowMenu>
                        </div>
                    );
                })}
            </div>

            {error && (
                <p className="mt-1 border-t border-border px-2.5 py-2 text-xs break-words whitespace-pre-wrap text-danger">
                    {error}
                </p>
            )}
        </>
    );
}
