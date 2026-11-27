import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
    CheckIcon,
    CopyIcon,
    FolderIcon,
    FolderOpenIcon,
    GitBranchIcon,
    GitForkIcon,
    PlusIcon,
    TrashIcon
} from "@phosphor-icons/react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Workspace } from "@/features/composer/store";
import { ProjectIcon, projects, useProjects } from "@/features/projects";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import { isTauri, REVEAL_LABEL } from "@/lib/platform";
import type { Chat, Worktree } from "@/proto";
import { Menu, RowMenu, Tooltip } from "@/ui";
import {
    cardFooterButtonClassName,
    cardFooterClassName,
    cardListClassName,
    cardRowDetailClassName,
    chipClassName,
    chipTriggerClassName,
    popupClassName,
    rowMetaClassName,
    sideMenuItemClassName
} from "@/ui/chip";
import { DeleteBranchDialog, NewBranchDialog } from "./BranchDialogs";
import { BranchList, type BranchDialog } from "./BranchList";
import { CardSearch, useRows } from "./list";
import { git, useGitRepo } from "./store";

/** A row under a list, at the size of the rows above it: the chip's, not the composer's. */
const footerRowClassName = cn(cardFooterButtonClassName, "text-xs");

/** The chip whose card is open. */
type Card = "project" | "branch";

/** An absolute path: a drive, a root, a share or the home folder. */
const isPath = (text: string) => text.length > 1 && /^([a-zA-Z]:[\\/]|[\\/~])/.test(text);

/** The folder `path` sits in; its own name is already on the row. */
const parentOf = (path: string) => path.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]*$/, "");

/**
 * Where a chat works, in two chips under the composer: the project, then
 * its branch ("from main" when the next chat is to get a worktree of its
 * own).
 *
 * In the new-chat view the project chip lists the projects under a search
 * (a pasted path can be used as one; the folder button opens the system
 * dialog). In a checkout, the branch chip lists the branches, and under
 * them a "New worktree" switch: on, the chat gets a new branch in a folder
 * of its own on the first prompt, and picking a branch says what it starts
 * from, which leaves the checkout alone. Off, picking one switches to it.
 *
 * Once the chat exists its project is fixed (`chat`, or `frozen` while its
 * worktree is being made): only the branch chip opens, and for a worktree
 * chat its card ends with what it branched from and its folder.
 */
export function WorkspacePicker({
    chat,
    folder,
    cwd,
    frozen = false,
    onFolderChange,
    workspace,
    onWorkspaceChange,
    base,
    onBaseChange
}: {
    chat: Chat | null;
    /** The project: the chat's folder, or the one picked for the next chat. */
    folder: string | null;
    /** Where the agent works: a chat's worktree, else `folder`. */
    cwd: string | null;
    frozen?: boolean;
    onFolderChange: (path: string | null) => void;
    workspace: Workspace;
    onWorkspaceChange: (workspace: Workspace) => void;
    /** What a new chat's worktree starts from; null for the checked-out branch. */
    base: string | null;
    onBaseChange: (base: string | null) => void;
}) {
    const repo = useGitRepo(cwd);
    const [open, setOpen] = useState<Card | null>(null);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [dialog, setDialog] = useState<BranchDialog | null>(null);

    const picking = !chat && !frozen;
    // A worktree starts from a commit.
    const canWorktree = !!repo?.commit;
    const mode: Workspace = !chat && workspace === "worktree" && canWorktree ? "worktree" : "local";
    const head = repo ? (repo.branch ?? repo.commit ?? "No commits") : "";
    /** The base shown: the picked one while it's still there, else what's checked out. */
    const from =
        (base && repo?.branches.some((b) => b.name === base) ? base : null) ?? repo?.branch ?? repo?.commit ?? "HEAD";
    const forked = mode === "worktree" || !!chat?.worktree;

    const projectLabel = (
        <>
            {folder ? <ProjectIcon path={folder} className="size-3.5" /> : <FolderIcon className="size-3.5 shrink-0" />}
            <span className="truncate">{folder ? baseName(folder) : "Choose a folder"}</span>
        </>
    );
    const branchLabel = (
        <>
            {forked ? <GitForkIcon className="size-3 shrink-0" /> : <GitBranchIcon className="size-3 shrink-0" />}
            <span className="truncate">{mode === "worktree" ? `from ${from}` : head}</span>
        </>
    );
    // Yields first under pressure, so the project's name truncates last.
    const branchChipClassName = "shrink-[1000]";

    /** The project where it can't be changed, its full path on hover. */
    const fixedProject = folder && (
        <Tooltip>
            <Tooltip.Trigger render={<span className={cn(chipClassName, "cursor-default")} />}>
                {projectLabel}
            </Tooltip.Trigger>
            <Tooltip.Content side="top">{folder}</Tooltip.Content>
        </Tooltip>
    );

    // Nothing to pick: a fixed project outside a checkout, or a worktree on its way.
    if (frozen || (chat && !repo)) {
        return (
            <>
                {fixedProject}
                {folder && repo && (
                    <span className={cn(chipClassName, branchChipClassName, "cursor-default")}>{branchLabel}</span>
                )}
            </>
        );
    }

    const close = () => setOpen(null);
    const onOpenChange = (card: Card) => (next: boolean) => {
        // The other chip's press may already have opened its card.
        setOpen((current) => (next ? card : current === card ? null : current));
        if (next && cwd) void git.refresh(cwd);
    };
    const openDialog = (next: BranchDialog) => {
        setMenuFor(null);
        close();
        setDialog(next);
    };
    const baseChoice = mode === "worktree" ? { value: from, onChange: onBaseChange } : undefined;

    return (
        <>
            {picking ? (
                <ChipCard
                    open={open === "project"}
                    onOpenChange={onOpenChange("project")}
                    held={!!menuFor}
                    label="Choose a project"
                    tooltip={folder}
                    chip={projectLabel}
                    chipClassName={cn(!folder && "text-warning")}
                >
                    <ProjectCard
                        folder={folder}
                        onFolderChange={onFolderChange}
                        menuFor={menuFor}
                        onMenuChange={setMenuFor}
                        onClose={close}
                    />
                </ChipCard>
            ) : (
                fixedProject
            )}

            {folder && cwd && repo && (
                <ChipCard
                    open={open === "branch"}
                    onOpenChange={onOpenChange("branch")}
                    held={!!menuFor}
                    label={mode === "worktree" ? "Choose what the worktree starts from" : "Switch branch"}
                    chip={branchLabel}
                    chipClassName={branchChipClassName}
                >
                    <BranchList
                        cwd={cwd}
                        repo={repo}
                        base={baseChoice}
                        menuFor={menuFor}
                        onMenuChange={setMenuFor}
                        onDialog={openDialog}
                        onDone={close}
                    />
                    {picking && (
                        <WorktreeSwitch
                            checked={mode === "worktree"}
                            disabled={!canWorktree}
                            onChange={(on) => onWorkspaceChange(on ? "worktree" : "local")}
                        />
                    )}
                    {chat?.worktree && <WorktreeFooter worktree={chat.worktree} />}
                </ChipCard>
            )}

            {cwd && (
                <>
                    <NewBranchDialog
                        cwd={cwd}
                        from={dialog?.kind === "new" ? dialog.from : null}
                        onClose={() => setDialog(null)}
                    />
                    <DeleteBranchDialog
                        cwd={cwd}
                        branch={dialog?.kind === "delete" ? dialog.branch : null}
                        into={head}
                        onClose={() => setDialog(null)}
                    />
                </>
            )}
        </>
    );
}

/** A chip under the composer and the card it opens above itself. */
function ChipCard({
    open,
    onOpenChange,
    held,
    label,
    tooltip,
    chip,
    chipClassName,
    children
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** A row's menu is open: it lives outside the popup, and the card stays open under it. */
    held: boolean;
    /** The card's accessible name. */
    label: string;
    /** Shown over the chip on hover; quiet while the card is open. */
    tooltip?: string | null;
    chip: ReactNode;
    chipClassName?: string;
    children: ReactNode;
}) {
    return (
        <Popover.Root
            open={open}
            onOpenChange={(next, details) => {
                if (!next && held) {
                    details.cancel();
                    return;
                }
                onOpenChange(next);
            }}
        >
            <Tooltip disabled={!tooltip || open}>
                <Tooltip.Trigger render={<Popover.Trigger className={cn(chipTriggerClassName, chipClassName)} />}>
                    {chip}
                </Tooltip.Trigger>
                <Tooltip.Content side="top">{tooltip}</Tooltip.Content>
            </Tooltip>
            <Popover.Portal>
                <Popover.Positioner
                    side="top"
                    align="start"
                    sideOffset={8}
                    // The extra room on top keeps it off the top bar, the window's drag handle.
                    collisionPadding={{ top: 48, right: 12, bottom: 12, left: 12 }}
                    className="outline-none"
                >
                    <Popover.Popup aria-label={label} className={cn(popupClassName, "w-72 min-w-0 p-1")}>
                        {children}
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
}

/** The first row while the search is a path that isn't listed. */
const USE = "\u0000use";

/** The projects under a search. */
function ProjectCard({
    folder,
    onFolderChange,
    menuFor,
    onMenuChange,
    onClose
}: {
    folder: string | null;
    onFolderChange: (path: string | null) => void;
    menuFor: string | null;
    onMenuChange: (key: string | null) => void;
    onClose: () => void;
}) {
    const known = useProjects();
    const [query, setQuery] = useState("");
    const typed = query.trim();
    const q = typed.toLowerCase();
    const folders = folder && !known.includes(folder) ? [...known, folder] : known;
    const usable = isPath(typed) && !folders.includes(typed);
    const keys = [...(usable ? [USE] : []), ...folders.filter((path) => path.toLowerCase().includes(q))];
    const rows = useRows(keys, folder, q.length > 0);

    const pick = (key: string) => {
        const path = key === USE ? typed : key;
        projects.add(path);
        onFolderChange(path);
        onClose();
    };

    const browse = async () => {
        onClose();
        const chosen = await openFolderDialog({
            directory: true,
            defaultPath: folder ?? undefined,
            title: "Choose a folder"
        });
        if (typeof chosen === "string") {
            projects.add(chosen);
            onFolderChange(chosen);
        }
    };

    return (
        <>
            <CardSearch
                value={query}
                onChange={(next) => {
                    setQuery(next);
                    rows.reset();
                }}
                onKeyDown={(event) => void rows.onKeyDown(event, pick)}
                placeholder="Search or paste a path"
                controls={rows.listId}
                activeId={rows.activeId}
            >
                <Tooltip content="Open folder…" side="top">
                    <button
                        type="button"
                        aria-label="Open folder"
                        // No native dialog in a browser-only run.
                        disabled={!isTauri}
                        onClick={() => void browse()}
                        className={cn(
                            "-mr-2 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted/75 outline-none",
                            "transition-colors duration-100 hover:bg-hover hover:text-text focus-visible:bg-hover",
                            "disabled:pointer-events-none disabled:opacity-50"
                        )}
                    >
                        <FolderOpenIcon className="size-3.5" />
                    </button>
                </Tooltip>
            </CardSearch>

            {!keys.length && (
                <p className="px-2.5 py-3 text-center text-xs text-muted/75">
                    {folders.length ? "No projects match." : "No projects yet."}
                </p>
            )}

            <div id={rows.listId} role="listbox" aria-label="Projects" className={cardListClassName}>
                {keys.map((path) =>
                    path === USE ? (
                        <div key={USE} {...rows.row(USE, false, () => pick(USE))}>
                            <PlusIcon className="size-3.5 shrink-0 text-muted" />
                            <span className="min-w-0 flex-1 truncate">Use {typed}</span>
                        </div>
                    ) : (
                        <div key={path} {...rows.row(path, path === folder, () => pick(path))}>
                            <ProjectIcon path={path} selected={path === folder} />
                            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                <span className="max-w-full shrink-0 truncate font-medium">{baseName(path)}</span>
                                {/* Where it lives, for the row under the pointer or the arrow keys. */}
                                <span className={cardRowDetailClassName}>{parentOf(path)}</span>
                            </span>
                            <span className={cn(rowMetaClassName, menuFor === path && "hidden")}>
                                {path === folder && <CheckIcon className="size-3" weight="bold" />}
                            </span>
                            <RowMenu
                                label={`Options for ${baseName(path)}`}
                                open={menuFor === path}
                                onOpenChange={(next) => onMenuChange(next ? path : null)}
                            >
                                <Menu.Item
                                    disabled={!isTauri}
                                    onClick={() => void revealItemInDir(path).catch(() => {})}
                                    className={sideMenuItemClassName}
                                >
                                    <FolderOpenIcon />
                                    {REVEAL_LABEL}
                                </Menu.Item>
                                <Menu.Item onClick={() => void copyText(path)} className={sideMenuItemClassName}>
                                    <CopyIcon />
                                    Copy path
                                </Menu.Item>
                                <Menu.Separator />
                                <Menu.Item
                                    variant="destructive"
                                    onClick={() => {
                                        projects.remove(path);
                                        if (path === folder) onFolderChange(null);
                                    }}
                                    className={sideMenuItemClassName}
                                >
                                    <TrashIcon />
                                    Remove
                                </Menu.Item>
                            </RowMenu>
                        </div>
                    )
                )}
            </div>
        </>
    );
}

/**
 * Under the branches of a new chat: on, the chat gets a worktree (a new
 * branch in a folder of its own) and the list above picks what it starts
 * from. The track and thumb are `Switch`'s at `sm`.
 */
function WorktreeSwitch({
    checked,
    disabled,
    onChange
}: {
    checked: boolean;
    /** A worktree starts from a commit, and there isn't one yet. */
    disabled: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <div className={cardFooterClassName}>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                disabled={disabled}
                // The search keeps the focus, and the arrow keys the list.
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => onChange(!checked)}
                className={cn(footerRowClassName, "group/switch")}
            >
                <GitForkIcon className="size-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-left">New worktree</span>
                {disabled ? (
                    <span className="shrink-0 pr-1 text-[11px] text-muted/75">Needs a first commit</span>
                ) : (
                    <span
                        aria-hidden="true"
                        className={cn(
                            "mr-1 flex h-4 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ease-out",
                            checked ? "bg-accent" : "bg-hover group-hover/switch:bg-border"
                        )}
                    >
                        <span
                            className={cn(
                                "block size-3 rounded-full shadow-sm shadow-shadow/30",
                                "transition-[translate,background-color] duration-150 ease-out motion-reduce:transition-none",
                                checked ? "translate-x-2 bg-accent-fg" : "bg-text"
                            )}
                        />
                    </span>
                )}
            </button>
        </div>
    );
}

/** A started chat's worktree, under its branches: what it branched from and its folder, with Copy and Reveal. */
function WorktreeFooter({ worktree }: { worktree: Worktree }) {
    return (
        <div className={cardFooterClassName}>
            <div className="flex flex-col gap-0.5 px-2 pt-1 pb-1.5 text-xs">
                <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-text">Worktree</span>
                    <span className="shrink-0 text-muted/75">from {worktree.base}</span>
                </span>
                <span className="truncate text-[11px] text-muted/75">{worktree.root}</span>
            </div>
            <button type="button" onClick={() => void copyText(worktree.path)} className={footerRowClassName}>
                <CopyIcon className="size-3.5 shrink-0 text-muted" />
                Copy path
            </button>
            <button
                type="button"
                disabled={!isTauri}
                onClick={() => void revealItemInDir(worktree.path).catch(() => {})}
                className={footerRowClassName}
            >
                <FolderOpenIcon className="size-3.5 shrink-0 text-muted" />
                {REVEAL_LABEL}
            </button>
        </div>
    );
}
