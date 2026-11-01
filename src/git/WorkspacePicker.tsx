import type { ReactNode } from "react";
import {
    CheckIcon,
    CopyIcon,
    FolderOpenIcon,
    GitBranchIcon,
    GitForkIcon,
    LaptopIcon
} from "@phosphor-icons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Workspace } from "@/composer";
import {
    chipClassName,
    chipTriggerClassName,
    sideMenuClassName,
    sideMenuItemClassName
} from "@/ui/chip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { isTauri, REVEAL_LABEL } from "@/lib/platform";
import type { Chat } from "@/proto";
import { Menu, Tooltip } from "@/ui";
import { useGitRepo } from "./store";

const LABELS: Record<Workspace, string> = {
    local: "Local",
    worktree: "Worktree"
};

const ICONS: Record<Workspace, ReactNode> = {
    local: <LaptopIcon className="size-3.5 shrink-0" />,
    worktree: <GitForkIcon className="size-3.5 shrink-0" />
};

/**
 * Where a new chat in `cwd` works, as a chip after the folder chip: the
 * folder's own checkout ("Local", the branch chip beside it), or a worktree
 * made when the first prompt is sent: a new branch off `base` (null for the
 * checked-out branch) in a folder of its own, so the checkout here stays as
 * it is. Picking Worktree keeps the card open on its Base branch row, which
 * opens the branches in a card beside it; the chip then reads "Worktree
 * from base". Hidden outside a git checkout.
 */
export function WorkspacePicker({
    cwd,
    value,
    onChange,
    base,
    onBaseChange
}: {
    cwd: string | null;
    value: Workspace;
    onChange: (value: Workspace) => void;
    base: string | null;
    onBaseChange: (base: string | null) => void;
}) {
    const repo = useGitRepo(cwd)?.repo;
    if (!cwd || !repo) return null;
    // A worktree starts from a commit.
    const canWorktree = !!repo.commit;
    const current = canWorktree ? value : "local";
    const names = repo.branches.map((b) => b.name);
    /** The base shown: the picked one while it's still there, else what's checked out. */
    const from =
        (base && names.includes(base) ? base : null) ?? repo.branch ?? repo.commit ?? "HEAD";

    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <Menu.Trigger className={chipTriggerClassName}>
                            {ICONS[current]}
                            <span className="truncate">{LABELS[current]}</span>
                            {current === "worktree" && (
                                <span className="min-w-0 shrink-[1000] truncate text-dark-250">
                                    from {from}
                                </span>
                            )}
                        </Menu.Trigger>
                    }
                />
                <Tooltip.Content side="top">Where the agent works</Tooltip.Content>
            </Tooltip>
            <Menu.Content
                side="top"
                align="start"
                sideOffset={8}
                collisionPadding={12}
                className="w-64 min-w-0"
            >
                <div className="flex flex-col">
                    <Option
                        workspace="local"
                        selected={current === "local"}
                        onSelect={() => onChange("local")}
                        description={`Works in this folder${repo.branch ? `, on ${repo.branch}` : ""}`}
                    />
                    <Option
                        workspace="worktree"
                        selected={current === "worktree"}
                        disabled={!canWorktree}
                        // Stays open on the base row.
                        keepOpen
                        onSelect={() => onChange("worktree")}
                        description={canWorktree ? "Its own branch and folder" : "Needs a first commit"}
                    />
                </div>
                {current === "worktree" && (
                    <>
                        <Menu.Separator />
                        <Menu.SubmenuRoot>
                            <Menu.SubmenuTrigger>
                                <span className="flex-1">Base branch</span>
                                <span className="max-w-32 truncate text-dark-250">{from}</span>
                            </Menu.SubmenuTrigger>
                            <Menu.Content
                                side="right"
                                align="end"
                                sideOffset={12}
                                alignOffset={-5}
                                className={cn(sideMenuClassName, "max-h-72")}
                            >
                                {names.map((name) => (
                                    <Menu.Item
                                        key={name}
                                        onClick={() =>
                                            onBaseChange(name === repo.branch ? null : name)
                                        }
                                        className={sideMenuItemClassName}
                                    >
                                        <span className="min-w-0 flex-1 truncate">{name}</span>
                                        {name === from && (
                                            <CheckIcon className="size-3" weight="bold" />
                                        )}
                                    </Menu.Item>
                                ))}
                            </Menu.Content>
                        </Menu.SubmenuRoot>
                    </>
                )}
            </Menu.Content>
        </Menu>
    );
}

function Option({
    workspace,
    selected,
    disabled,
    keepOpen,
    description,
    onSelect
}: {
    workspace: Workspace;
    selected: boolean;
    disabled?: boolean;
    keepOpen?: boolean;
    description: string;
    onSelect: () => void;
}) {
    return (
        <Menu.Item
            disabled={disabled}
            closeOnClick={!keepOpen}
            onClick={() => {
                if (!selected) onSelect();
            }}
            className="grid grid-cols-[1fr_1rem] items-center gap-x-2"
        >
            <span className="flex min-w-0 flex-col">
                <span className="text-dark-50">{LABELS[workspace]}</span>
                <span className="truncate text-[11px] text-dark-250">{description}</span>
            </span>
            {selected && <CheckIcon className="size-3" weight="bold" />}
        </Menu.Item>
    );
}

/**
 * Where a started chat works, locked: "Worktree" opens its branch and
 * folder with Copy and Reveal; "Local" is a plain label (hidden outside a
 * git checkout).
 */
export function WorkspaceChip({ chat }: { chat: Chat }) {
    const repo = useGitRepo(chat.worktree ? null : chat.cwd)?.repo;
    const worktree = chat.worktree;

    if (!worktree) {
        if (!repo) return null;
        return (
            <span className={cn(chipClassName, "cursor-default")}>
                {ICONS.local}
                <span className="truncate">{LABELS.local}</span>
            </span>
        );
    }

    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <Menu.Trigger className={chipTriggerClassName}>
                            {ICONS.worktree}
                            <span className="truncate">{LABELS.worktree}</span>
                        </Menu.Trigger>
                    }
                />
                <Tooltip.Content side="top">Where the agent works</Tooltip.Content>
            </Tooltip>
            <Menu.Content
                side="top"
                align="start"
                sideOffset={8}
                className="w-80 min-w-0"
            >
                <div className="flex flex-col gap-1 px-2.5 pt-1.5 pb-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2 text-dark-50">
                        <GitBranchIcon className="size-3.5 shrink-0 text-dark-200" />
                        <span className="truncate">{worktree.branch}</span>
                        <span className="shrink-0 text-dark-250">from {worktree.base}</span>
                    </span>
                    <span className="truncate pl-5.5 text-[11px] text-dark-250">
                        {worktree.root}
                    </span>
                </div>
                <Menu.Separator />
                <Menu.Item
                    onClick={() => void copyText(worktree.path)}
                    className={sideMenuItemClassName}
                >
                    <CopyIcon className="size-3.5" />
                    Copy path
                </Menu.Item>
                <Menu.Item
                    onClick={() => void copyText(worktree.branch)}
                    className={sideMenuItemClassName}
                >
                    <CopyIcon className="size-3.5" />
                    Copy branch name
                </Menu.Item>
                <Menu.Item
                    disabled={!isTauri}
                    onClick={() => void revealItemInDir(worktree.path).catch(() => {})}
                    className={sideMenuItemClassName}
                >
                    <FolderOpenIcon className="size-3.5" />
                    {REVEAL_LABEL}
                </Menu.Item>
            </Menu.Content>
        </Menu>
    );
}
