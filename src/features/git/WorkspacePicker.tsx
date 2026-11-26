import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
    CaretRightIcon,
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
import type { Chat, GitRepo, Worktree } from "@/proto";
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

/** A row is 32px plus the list's 2px gap. */
const ROW_PITCH = 34;

/** A row under a list, at the size of the rows above it: the chip's, not the composer's. */
const footerRowClassName = cn(cardFooterButtonClassName, "text-xs");

const SEARCH_ID = "workspace-picker-search";

/** The footer row whose card is open beside the picker. */
type Side = "workspace" | "branch";

/** An absolute path: a drive, a root, a share or the home folder. */
const isPath = (text: string) => text.length > 1 && /^([a-zA-Z]:[\\/]|[\\/~])/.test(text);

/** The folder `path` sits in; its own name is already on the row. */
const parentOf = (path: string) => path.replace(/[/\\]+$/, "").replace(/[/\\][^/\\]*$/, "");

/**
 * Where a chat works, in one chip under the composer, as the model picker
 * is one chip in it: the project, then its branch ("worktree from main"
 * when the next chat is to get a worktree of its own).
 *
 * In the new-chat view the card lists the projects under a search (a pasted
 * path can be used as one; the folder button opens the system dialog). In a
 * checkout, two rows under the list open their choices beside the card:
 * "Work in" (this folder, or a worktree made on the first prompt: a new
 * branch in a folder of its own) and "Branch" (switches the checkout; for a
 * worktree, "Starts from", which leaves the checkout alone).
 *
 * Once the chat exists its project is fixed (`chat`, or `frozen` while its
 * worktree is being made): the card is then just the branches, and for a
 * worktree chat what it branched from and its folder.
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
    const [open, setOpen] = useState(false);
    const [side, setSide] = useState<Side | null>(null);
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

    const label = (
        <>
            {folder ? <ProjectIcon path={folder} className="size-3.5" /> : <FolderIcon className="size-3.5 shrink-0" />}
            <span className="truncate">{folder ? baseName(folder) : "Choose a folder"}</span>
            {folder && repo && (
                // Yields first under pressure, so the project's name truncates last.
                <span className="flex min-w-0 shrink-[1000] items-center gap-1 text-muted/75">
                    {forked ? (
                        <GitForkIcon className="size-3 shrink-0" />
                    ) : (
                        <GitBranchIcon className="size-3 shrink-0" />
                    )}
                    <span className="truncate">{mode === "worktree" ? `worktree from ${from}` : head}</span>
                </span>
            )}
        </>
    );

    // Nothing to pick: a fixed project outside a checkout, or a worktree on its way.
    if (frozen || (chat && !repo)) {
        if (!folder) return null;
        return (
            <Tooltip>
                <Tooltip.Trigger render={<span className={cn(chipClassName, "max-w-96 cursor-default")} />}>
                    {label}
                </Tooltip.Trigger>
                <Tooltip.Content side="top">{folder}</Tooltip.Content>
            </Tooltip>
        );
    }

    const close = () => {
        setOpen(false);
        setSide(null);
    };
    const openDialog = (next: BranchDialog) => {
        setMenuFor(null);
        close();
        setDialog(next);
    };
    /** A side card is done: the keyboard goes back to the projects' search. */
    const closeSide = () => {
        setSide(null);
        document.getElementById(SEARCH_ID)?.focus();
    };
    const baseChoice = mode === "worktree" ? { value: from, onChange: onBaseChange } : undefined;

    return (
        <>
            <Popover.Root
                open={open}
                onOpenChange={(next, details) => {
                    // A row's menu lives outside the popup; the card stays open under it.
                    if (!next && menuFor) {
                        details.cancel();
                        return;
                    }
                    setOpen(next);
                    if (next && cwd) void git.refresh(cwd);
                    if (!next) setSide(null);
                }}
            >
                {/* The full path on hover; quiet while the card is open. */}
                <Tooltip disabled={!folder || open}>
                    <Tooltip.Trigger
                        render={
                            <Popover.Trigger
                                className={cn(chipTriggerClassName, "max-w-96", !folder && "text-warning")}
                            />
                        }
                    >
                        {label}
                    </Tooltip.Trigger>
                    <Tooltip.Content side="top">{folder}</Tooltip.Content>
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
                        <Popover.Popup
                            aria-label={picking ? "Choose a project" : "Switch branch"}
                            className={cn(popupClassName, "w-80 min-w-0 rounded-xl p-1")}
                        >
                            {picking ? (
                                <ProjectCard
                                    folder={folder}
                                    onFolderChange={onFolderChange}
                                    repo={repo}
                                    mode={mode}
                                    branch={mode === "worktree" ? from : head}
                                    menuFor={menuFor}
                                    onMenuChange={setMenuFor}
                                    side={side}
                                    onToggleSide={(next) => setSide((s) => (s === next ? null : next))}
                                    onClose={close}
                                />
                            ) : (
                                cwd &&
                                repo && (
                                    <>
                                        <BranchList
                                            cwd={cwd}
                                            repo={repo}
                                            menuFor={menuFor}
                                            onMenuChange={setMenuFor}
                                            onDialog={openDialog}
                                            onDone={close}
                                        />
                                        {chat?.worktree && <WorktreeFooter worktree={chat.worktree} />}
                                    </>
                                )
                            )}
                        </Popover.Popup>
                        {/* Siblings of the popup, which clips its overflow; the
                            positioner is what they're placed against. */}
                        {picking && side === "workspace" && repo && (
                            <SideCard lift className="w-60">
                                <WorkspaceChoices
                                    value={mode}
                                    canWorktree={canWorktree}
                                    branch={repo.branch}
                                    onSelect={(next) => {
                                        onWorkspaceChange(next);
                                        closeSide();
                                    }}
                                />
                            </SideCard>
                        )}
                        {picking && side === "branch" && cwd && repo && (
                            <SideCard className="w-72">
                                <BranchList
                                    cwd={cwd}
                                    repo={repo}
                                    base={baseChoice}
                                    menuFor={menuFor}
                                    onMenuChange={setMenuFor}
                                    onDialog={openDialog}
                                    onDone={closeSide}
                                    onEscape={closeSide}
                                />
                            </SideCard>
                        )}
                    </Popover.Positioner>
                </Popover.Portal>
            </Popover.Root>

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

/** The first row while the search is a path that isn't listed. */
const USE = "\u0000use";

/** The projects under a search, then the picked one's workspace and branch rows. */
function ProjectCard({
    folder,
    onFolderChange,
    repo,
    mode,
    branch,
    menuFor,
    onMenuChange,
    side,
    onToggleSide,
    onClose
}: {
    folder: string | null;
    onFolderChange: (path: string | null) => void;
    repo: GitRepo | null | undefined;
    mode: Workspace;
    /** The branch row's value. */
    branch: string;
    menuFor: string | null;
    onMenuChange: (key: string | null) => void;
    side: Side | null;
    onToggleSide: (side: Side) => void;
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
                id={SEARCH_ID}
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

            {/* They belong to the picked project, not the highlighted one. */}
            {folder && repo && (
                <div className={cardFooterClassName}>
                    <FooterRow
                        label="Work in"
                        value={mode === "worktree" ? "New worktree" : "Local"}
                        expanded={side === "workspace"}
                        onClick={() => onToggleSide("workspace")}
                    />
                    <FooterRow
                        label={mode === "worktree" ? "Starts from" : "Branch"}
                        value={branch}
                        expanded={side === "branch"}
                        onClick={() => onToggleSide("branch")}
                    />
                </div>
            )}
        </>
    );
}

/** A footer row: its setting and value, opening its choices beside the card. */
function FooterRow({
    label,
    value,
    expanded,
    onClick
}: {
    label: string;
    value: string;
    expanded: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            aria-expanded={expanded}
            onClick={onClick}
            className={cn(footerRowClassName, "aria-expanded:bg-hover")}
        >
            <span className="shrink-0">{label}</span>
            <span className="ml-auto min-w-0 truncate text-muted/75">{value}</span>
            <CaretRightIcon className="size-3 shrink-0 text-muted/75" weight="bold" />
        </button>
    );
}

/**
 * A footer row's choices, beside the card's bottom edge and level with the
 * row that opened it: `lift` raises it one row, for the row above the last.
 * On the card's right, or its left when the window ends too soon.
 */
function SideCard({ lift = false, className, children }: { lift?: boolean; className?: string; children: ReactNode }) {
    const [flipped, setFlipped] = useState(false);
    return (
        <div
            ref={(element) => {
                if (element && element.getBoundingClientRect().right > window.innerWidth - 8) setFlipped(true);
            }}
            style={lift ? { bottom: ROW_PITCH } : undefined}
            className={cn(
                "pointer-events-auto absolute bottom-0 flex flex-col overflow-hidden",
                flipped ? "right-full mr-2" : "left-full ml-2",
                "rounded-xl border border-border bg-surface p-1 text-text shadow-lg shadow-shadow/40",
                "transition-opacity duration-150 ease-out starting:opacity-0",
                className
            )}
        >
            {children}
        </div>
    );
}

/** Local or a new worktree, each with what it means. */
function WorkspaceChoices({
    value,
    canWorktree,
    branch,
    onSelect
}: {
    value: Workspace;
    canWorktree: boolean;
    branch: string | undefined;
    onSelect: (value: Workspace) => void;
}) {
    const options: { id: Workspace; label: string; description: string; disabled?: boolean }[] = [
        { id: "local", label: "Local", description: `This folder${branch ? `, on ${branch}` : ""}` },
        {
            id: "worktree",
            label: "New worktree",
            description: canWorktree ? "Its own branch and folder" : "Needs a first commit",
            disabled: !canWorktree
        }
    ];
    return (
        <div role="radiogroup" aria-label="Where the agent works" className="flex flex-col gap-0.5">
            {options.map((option) => {
                const checked = option.id === value;
                return (
                    <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        disabled={option.disabled}
                        onClick={() => onSelect(option.id)}
                        className={cn(
                            "grid w-full grid-cols-[1fr_1rem] items-center gap-x-2 rounded-[7px] px-2.5 py-1.5",
                            "text-left outline-none select-none hover:bg-hover focus-visible:bg-hover",
                            "disabled:pointer-events-none disabled:opacity-50"
                        )}
                    >
                        <span className="flex min-w-0 flex-col">
                            <span className="text-xs font-medium text-text">{option.label}</span>
                            <span className="truncate text-[11px] text-muted/75">{option.description}</span>
                        </span>
                        {checked && <CheckIcon className="size-3" weight="bold" />}
                    </button>
                );
            })}
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
