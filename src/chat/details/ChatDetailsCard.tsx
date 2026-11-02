import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
    ArrowUpRightIcon,
    CaretDownIcon,
    CodeIcon,
    FolderOpenIcon,
    GitDiffIcon,
    GitForkIcon,
    TerminalWindowIcon
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LineCounts } from "@/diff/DiffFiles";
import { parsePatch, totals } from "@/diff/patch";
import { useCheckoutDiff, useDiffPrefs } from "@/diff/store";
import { useGitRepo } from "@/git";
import { gitApi } from "@/git/api";
import { EDITORS, openInEditor, refreshEditors, useEditor, useEditorsStore } from "@/editors";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { workDir } from "@/chats";
import { ShortcutKeys, useBinding } from "@/keybindings";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import { isTauri } from "@/lib/platform";
import { ProjectIcon } from "@/projects/ProjectIcon";
import type { Chat, GitBranch } from "@/proto";
import { openDiffTab, openTerminalTab } from "@/rightbar";
import { GithubMark, Menu, Tooltip } from "@/ui";
import { DETAILS_CARD_GAP, DETAILS_CARD_WIDTH } from "./layout";

const reveal = (path: string) => void revealItemInDir(path).catch(() => {});

/**
 * The open chat's details, floating at the chat pane's top right over the
 * transcript. Sized to its content, scrolling past the pane's height.
 */
export function ChatDetailsCard({ chat }: { chat: Chat }) {
    return (
        <aside
            aria-label="Chat details"
            style={{
                top: DETAILS_CARD_GAP,
                right: DETAILS_CARD_GAP,
                width: DETAILS_CARD_WIDTH,
                maxHeight: `calc(100% - ${DETAILS_CARD_GAP * 2}px)`
            }}
            className={cn(
                "absolute z-20 flex flex-col overflow-y-auto overscroll-contain",
                "rounded-2xl border border-dark-600 bg-dark-850 text-dark-50 shadow-lg shadow-black/40"
            )}
        >
            <WorkspaceSection chat={chat} />
            <VersionControlSection folder={workDir(chat)} />
        </aside>
    );
}

/** Where the chat works: its project, its worktree, a terminal there. */
function WorkspaceSection({ chat }: { chat: Chat }) {
    const terminalKeys = useBinding("newTerminal");
    const worktree = chat.worktree;
    return (
        <Section label="Workspace">
            <Row
                icon={<ProjectIcon path={chat.cwd} className="size-4" />}
                label={baseName(chat.cwd)}
                tooltip={chat.cwd}
                onClick={isTauri ? () => reveal(chat.cwd) : undefined}
                meta={<FolderOpenIcon className="size-4 text-dark-250" />}
            />
            {worktree && (
                <Row
                    icon={<GitForkIcon className="size-4" />}
                    label="Worktree"
                    tooltip={worktree.path}
                    onClick={isTauri ? () => reveal(worktree.path) : undefined}
                    meta={<FolderOpenIcon className="size-4 text-dark-250" />}
                />
            )}
            <OpenInRow folder={workDir(chat)} />
            <Row
                icon={<TerminalWindowIcon className="size-4" />}
                label="Open terminal"
                onClick={() => openTerminalTab(workDir(chat))}
                meta={
                    terminalKeys && (
                        <ShortcutKeys shortcut={terminalKeys} variant="plain" className="text-dark-250" />
                    )
                }
            />
        </Section>
    );
}

/** The checkout where the agent works: its uncommitted changes, its GitHub page. Nothing outside a checkout. */
function VersionControlSection({ folder }: { folder: string }) {
    const repo = useGitRepo(folder)?.repo;
    if (!repo) return null;
    return (
        <Section label="Version control">
            <ChangesRow folder={folder} />
            <GithubRow folder={folder} branch={repo.branches.find((b) => b.current)} />
        </Section>
    );
}

/** The working tree's changes against HEAD ("+251 −5"), opening the diff tab on them. */
function ChangesRow({ folder }: { folder: string }) {
    const diff = useCheckoutDiff(folder, undefined)?.diff;
    const sum = useMemo(() => (diff ? totals(parsePatch(diff.patch)) : null), [diff]);
    return (
        <Row
            icon={<GitDiffIcon className="size-4" />}
            label="Changes"
            tooltip={
                !sum
                    ? undefined
                    : sum.files === 0
                      ? "No uncommitted changes"
                      : `${sum.files === 1 ? "1 file" : `${sum.files} files`} changed`
            }
            onClick={() => {
                useDiffPrefs.getState().setScope("workingTree");
                openDiffTab();
            }}
            meta={
                sum &&
                (sum.files === 0 ? (
                    <span className="text-xs font-normal text-dark-250">None</span>
                ) : (
                    <span className="flex items-center gap-1.5 text-xs">
                        <LineCounts additions={sum.additions} deletions={sum.deletions} />
                    </span>
                ))
            }
        />
    );
}

/** Each folder's GitHub `owner/repo` (null: not GitHub), read once per launch. */
const githubRemotes = new Map<string, Promise<string | null>>();

function useGithubRemote(folder: string) {
    const [remote, setRemote] = useState<{ folder: string; repo: string | null } | null>(null);
    useEffect(() => {
        let live = true;
        let read = githubRemotes.get(folder);
        if (!read) {
            read = gitApi.githubRemote(folder).catch(() => null);
            githubRemotes.set(folder, read);
        }
        void read.then((repo) => live && setRemote({ folder, repo }));
        return () => {
            live = false;
        };
    }, [folder]);
    return remote?.folder === folder ? remote.repo : null;
}

/**
 * The repository on GitHub, at the checked-out branch when it's pushed (it
 * has an upstream on `origin`), else its front page. Hidden for other hosts.
 */
function GithubRow({ folder, branch }: { folder: string; branch?: GitBranch }) {
    const repo = useGithubRemote(folder);
    if (!repo) return null;
    const pushed = branch?.upstream?.startsWith("origin/") ? branch.upstream.slice("origin/".length) : null;
    const url = `https://github.com/${repo}${pushed ? `/tree/${encodeURI(pushed)}` : ""}`;
    return (
        <Row
            icon={<GithubMark className="size-4" />}
            label="Open on GitHub"
            tooltip={url}
            onClick={() => void openUrl(url).catch(() => {})}
            meta={<ArrowUpRightIcon className="size-3.5 text-dark-250" />}
        />
    );
}

/** The editor's mark, else a generic code icon. */
function EditorMark({ id, className }: { id: string; className?: string }) {
    const Mark = EDITORS[id]?.icon;
    return Mark ? <Mark className={className} aria-hidden /> : <CodeIcon className={className} />;
}

/**
 * "Open in VS Code": opens the folder in the editor picked last, else the
 * first installed; the chevron lists the installed ones to pick from.
 */
function OpenInRow({ folder }: { folder: string }) {
    const { installed, current } = useEditor();
    const setPreferred = useEditorsStore((s) => s.setPreferred);
    useEffect(() => void refreshEditors(), []);

    if (installed && installed.length === 0) {
        return (
            <Row
                icon={<CodeIcon className="size-4" />}
                label="No editors found"
                tooltip="Install VS Code, Cursor, Zed or a JetBrains IDE to open folders from here"
            />
        );
    }

    return (
        <div className="flex h-8 w-full min-w-0 items-center">
            <button
                type="button"
                disabled={!current}
                onClick={() => current && void openInEditor(current, folder).catch(() => {})}
                className={cn(
                    "flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-s-lg px-2.5 text-left outline-none select-none",
                    "text-[13px] font-medium text-dark-100 transition-colors",
                    "hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
                )}
            >
                <span className="flex size-4 shrink-0 items-center justify-center text-dark-250">
                    {current ? (
                        <EditorMark id={current} className="size-4" />
                    ) : (
                        <CodeIcon className="size-4" />
                    )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                    Open in {current ? EDITORS[current].label : "editor"}
                </span>
            </button>
            <Menu>
                <Menu.Trigger
                    aria-label="Choose editor"
                    disabled={!installed}
                    className={cn(
                        "flex h-full w-8 shrink-0 items-center justify-center rounded-e-lg text-dark-250 outline-none transition-colors",
                        "hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700",
                        "data-[popup-open]:bg-dark-700 data-[popup-open]:text-dark-50"
                    )}
                >
                    <CaretDownIcon className="size-3.5" />
                </Menu.Trigger>
                <Menu.Content side="bottom" align="end" className="w-52 min-w-0">
                    <Menu.RadioGroup value={current} onValueChange={(id: string) => setPreferred(id)}>
                        {installed?.map((id) => (
                            <Menu.RadioItem key={id} value={id} className="gap-2">
                                <EditorMark id={id} className="size-4 shrink-0" />
                                {EDITORS[id].label}
                            </Menu.RadioItem>
                        ))}
                    </Menu.RadioGroup>
                </Menu.Content>
            </Menu>
        </div>
    );
}

/** A group of rows; the next one starts under a hairline. */
function Section({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section aria-label={label} className="flex flex-col p-2 not-first:border-t not-first:border-dark-700">
            {children}
        </section>
    );
}

/**
 * A 32px row: icon, label, then `meta` at the end. A button when it does
 * something; `tooltip` shows on hover, to its left.
 */
function Row({
    icon,
    label,
    meta,
    tooltip,
    onClick
}: {
    icon: ReactNode;
    label: string;
    meta?: ReactNode;
    tooltip?: string;
    onClick?: () => void;
}) {
    const content = (
        <>
            <span className="flex size-4 shrink-0 items-center justify-center text-dark-250">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {meta && <span className="flex shrink-0 items-center">{meta}</span>}
        </>
    );
    const className = cn(
        "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left",
        "text-[13px] font-medium text-dark-100 outline-none select-none",
        onClick && "transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
    );
    const row = onClick ? (
        <button type="button" onClick={onClick} className={className}>
            {content}
        </button>
    ) : (
        <div className={className}>{content}</div>
    );
    if (!tooltip) return row;
    return (
        <Tooltip>
            <Tooltip.Trigger render={row} />
            <Tooltip.Content side="left">{tooltip}</Tooltip.Content>
        </Tooltip>
    );
}
