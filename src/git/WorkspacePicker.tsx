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
import { chipClassName, chipTriggerClassName } from "@/composer/chip";
import { cn } from "@/lib/cn";
import { isTauri, platform } from "@/lib/platform";
import type { Chat } from "@/proto";
import { Menu, Tooltip } from "@/ui";
import { useGitRepo } from "./store";

const LABELS: Record<Workspace, string> = {
    local: "Current checkout",
    worktree: "New worktree"
};

const ICONS: Record<Workspace, ReactNode> = {
    local: <LaptopIcon className="size-3.5 shrink-0" />,
    worktree: <GitForkIcon className="size-3.5 shrink-0" />
};

const REVEAL_LABEL =
    platform === "macos"
        ? "Reveal in Finder"
        : platform === "windows"
          ? "Show in Explorer"
          : "Show in folder";

const copy = (text: string) => void navigator.clipboard.writeText(text).catch(() => {});

/**
 * Where a new chat in `cwd` works, as a chip after the branch chip: the
 * folder's own checkout, or a worktree made for it when the first prompt is
 * sent (a new branch off the branch chip's, in a folder of its own, so the
 * checkout here stays as it is). Hidden outside a git checkout.
 */
export function WorkspacePicker({
    cwd,
    value,
    onChange
}: {
    cwd: string | null;
    value: Workspace;
    onChange: (value: Workspace) => void;
}) {
    const repo = useGitRepo(cwd)?.repo;
    if (!cwd || !repo) return null;
    // A worktree starts from a commit.
    const canWorktree = !!repo.commit;
    const current = canWorktree ? value : "local";

    return (
        <Menu>
            <Tooltip>
                <Tooltip.Trigger
                    render={
                        <Menu.Trigger className={chipTriggerClassName}>
                            {ICONS[current]}
                            <span className="truncate">{LABELS[current]}</span>
                        </Menu.Trigger>
                    }
                />
                <Tooltip.Content side="top">
                    Where the agent works
                </Tooltip.Content>
            </Tooltip>
            <Menu.Content
                side="top"
                align="start"
                sideOffset={8}
                collisionPadding={12}
                className="w-64 min-w-0"
            >
                <Option
                    workspace="local"
                    selected={current === "local"}
                    onSelect={() => onChange("local")}
                    description="Works in this folder"
                />
                <Option
                    workspace="worktree"
                    selected={current === "worktree"}
                    disabled={!canWorktree}
                    onSelect={() => onChange("worktree")}
                    description={canWorktree ? "Own branch and folder" : "Needs a first commit"}
                />
            </Menu.Content>
        </Menu>
    );
}

function Option({
    workspace,
    selected,
    disabled,
    description,
    onSelect
}: {
    workspace: Workspace;
    selected: boolean;
    disabled?: boolean;
    description: string;
    onSelect: () => void;
}) {
    return (
        <Menu.Item
            disabled={disabled}
            onClick={() => {
                if (!selected) onSelect();
            }}
            className="grid grid-cols-[1fr_1rem] items-center gap-x-2"
        >
            <span className="flex min-w-0 flex-col">
                <span className="text-dark-50">{LABELS[workspace]}</span>
                <span className="text-[11px] text-dark-250">{description}</span>
            </span>
            {selected && <CheckIcon className="size-3" weight="bold" />}
        </Menu.Item>
    );
}

/**
 * Where a started chat works, locked: "Worktree" opens its branch and
 * folder with Copy and Reveal; "Current checkout" is a plain label (hidden
 * outside a git checkout).
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
                            <span className="truncate">Worktree</span>
                        </Menu.Trigger>
                    }
                />
                <Tooltip.Content side="top">
                    Where the agent works
                </Tooltip.Content>
            </Tooltip>
            <Menu.Content side="top" align="start" sideOffset={8} className="w-80 min-w-0">
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
                <Menu.Item onClick={() => copy(worktree.path)}>
                    <CopyIcon className="size-3.5" />
                    Copy path
                </Menu.Item>
                <Menu.Item onClick={() => copy(worktree.branch)}>
                    <CopyIcon className="size-3.5" />
                    Copy branch name
                </Menu.Item>
                <Menu.Item
                    disabled={!isTauri}
                    onClick={() => void revealItemInDir(worktree.path).catch(() => {})}
                >
                    <FolderOpenIcon className="size-3.5" />
                    {REVEAL_LABEL}
                </Menu.Item>
            </Menu.Content>
        </Menu>
    );
}
