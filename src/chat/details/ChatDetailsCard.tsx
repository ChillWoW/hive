import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowDownIcon,
    ArrowsClockwiseIcon,
    ArrowUpIcon,
    ArrowUpRightIcon,
    CaretDownIcon,
    CloudArrowUpIcon,
    CodeIcon,
    CoinsIcon,
    FolderOpenIcon,
    GitDiffIcon,
    GitForkIcon,
    SlidersHorizontalIcon,
    TerminalWindowIcon
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LineCounts } from "@/diff/DiffFiles";
import { parsePatch, totals } from "@/diff/patch";
import { useCheckoutDiff, useDiffPrefs } from "@/diff/store";
import { useGitRepo } from "@/git";
import { git, useGitAction } from "@/git/store";
import { gitApi } from "@/git/api";
import { EDITORS, openInEditor, refreshEditors, useEditor, useEditorsStore } from "@/editors";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSession, workDir } from "@/chats";
import { formatCount, formatTokens } from "@/lib/format";
import { onWindowFocus } from "@/lib/windowFocus";
import { usageApi } from "@/usage/api";
import { useUsageStore } from "@/usage/store";
import { formatUsd } from "@/usage/format";
import { costTotal, processed } from "@/usage/summary";
import { ShortcutKeys, useBinding } from "@/keybindings";
import { cn } from "@/lib/cn";
import { baseName } from "@/lib/paths";
import { isTauri } from "@/lib/platform";
import { ProjectIcon } from "@/projects/ProjectIcon";
import type { Chat, ChatDetailsSettings, GitBranch, SessionUsage } from "@/proto";
import { openDiffTab, openTerminalTab } from "@/rightbar";
import { ContextMenu, DotMatrixSpinner, GithubMark, Menu, Tooltip } from "@/ui";
import { DetailsItemsMenuItems } from "./DetailsItemsMenu";
import { useDetailsItems } from "./items";
import { DETAILS_CARD_GAP, DETAILS_CARD_WIDTH, FIND_BAR_HEIGHT } from "./layout";

const reveal = (path: string) => void revealItemInDir(path).catch(() => {});

/**
 * The open chat's details, floating at the chat pane's top right over the
 * transcript. Sized to its content, scrolling past the pane's height.
 */
export function ChatDetailsCard({ chat, belowFind }: { chat: Chat; belowFind?: boolean }) {
    const shown = useDetailsItems();
    // The transcript's find bar takes the corner; the card goes under it.
    const top = belowFind ? DETAILS_CARD_GAP + FIND_BAR_HEIGHT + 8 : DETAILS_CARD_GAP;
    return (
        // Right-click anywhere on it: which rows it shows.
        <ContextMenu>
            <ContextMenu.Trigger
                render={
                    <aside
                        aria-label="Chat details"
                        style={{
                            top,
                            right: DETAILS_CARD_GAP,
                            width: DETAILS_CARD_WIDTH,
                            maxHeight: `calc(100% - ${top + DETAILS_CARD_GAP}px)`
                        }}
                        className={cn(
                            "group/details absolute z-20 flex transition-[top] duration-150 ease-out flex-col overflow-y-auto overscroll-contain",
                            "rounded-2xl border border-dark-600 bg-dark-850 text-dark-50 shadow-lg shadow-black/40"
                        )}
                    />
                }
            >
                <WorkspaceSection chat={chat} shown={shown} />
                {(shown.changes || shown.sync || shown.github) && (
                    <VersionControlSection folder={workDir(chat)} shown={shown} />
                )}
                {shown.cost && <SessionSection chat={chat} />}
                <EmptyCard />
            </ContextMenu.Trigger>
            <ContextMenu.Content className="w-56 min-w-0">
                <DetailsItemsMenuItems />
            </ContextMenu.Content>
        </ContextMenu>
    );
}

/** Only while every row is hidden: a way to bring some back. */
function EmptyCard() {
    return (
        <div className="p-2 group-has-[>section:not(:empty)]/details:hidden">
            <Menu>
                <Menu.Trigger
                    className={cn(
                        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none select-none",
                        "text-[13px] font-medium text-dark-200 transition-colors",
                        "hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700 data-[popup-open]:bg-dark-700"
                    )}
                >
                    <SlidersHorizontalIcon className="size-4 shrink-0 text-dark-250" />
                    Choose what to show
                </Menu.Trigger>
                <Menu.Content side="bottom" align="start" className="w-56 min-w-0">
                    <DetailsItemsMenuItems />
                </Menu.Content>
            </Menu>
        </div>
    );
}

/** Where the chat works: its project, its worktree, an editor and a terminal there. */
function WorkspaceSection({ chat, shown }: { chat: Chat; shown: ChatDetailsSettings }) {
    const terminalKeys = useBinding("newTerminal");
    const worktree = chat.worktree;
    return (
        <Section label="Workspace">
            {shown.project && (
                <Row
                    icon={<ProjectIcon path={chat.cwd} className="size-4" />}
                    label={baseName(chat.cwd)}
                    tooltip={chat.cwd}
                    onClick={isTauri ? () => reveal(chat.cwd) : undefined}
                    meta={<FolderOpenIcon className="size-4 text-dark-250" />}
                />
            )}
            {shown.worktree && worktree && (
                <Row
                    icon={<GitForkIcon className="size-4" />}
                    label="Worktree"
                    tooltip={worktree.path}
                    onClick={isTauri ? () => reveal(worktree.path) : undefined}
                    meta={<FolderOpenIcon className="size-4 text-dark-250" />}
                />
            )}
            {shown.openIn && <OpenInRow folder={workDir(chat)} />}
            {shown.terminal && (
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
            )}
        </Section>
    );
}

/** The checkout where the agent works: its uncommitted changes, sync with its upstream, its GitHub page. Nothing outside a checkout. */
function VersionControlSection({ folder, shown }: { folder: string; shown: ChatDetailsSettings }) {
    const repo = useGitRepo(folder)?.repo;
    if (!repo) return null;
    const current = repo.branches.find((b) => b.current);
    return (
        <Section label="Version control">
            {shown.changes && <ChangesRow folder={folder} />}
            {shown.sync && <SyncRow folder={folder} branch={current} />}
            {shown.github && <GithubRow folder={folder} branch={current} />}
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
                sum && sum.files > 0
                    ? `${sum.files === 1 ? "1 file" : `${sum.files} files`} changed`
                    : undefined
            }
            onClick={() => {
                useDiffPrefs.getState().setScope("workingTree");
                openDiffTab();
            }}
            // Nothing to show while the tree is clean.
            disabled={sum?.files === 0}
            meta={
                sum &&
                sum.files > 0 && (
                    <span className="flex items-center gap-1.5 text-xs">
                        <LineCounts additions={sum.additions} deletions={sum.deletions} />
                    </span>
                )
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

/** The chat's agent session: what it cost. Nothing before it has one. */
function SessionSection({ chat }: { chat: Chat }) {
    const usage = useChatCost(chat);
    if (!usage || usage.requests === 0) return null;
    return (
        <Section label="Session">
            <CostRow usage={usage} />
        </Section>
    );
}

/** Read again at most this often, unless a turn just ended. */
const COST_FRESH_MS = 30_000;

/**
 * What the chat's CLI session cost (`usage_session`, over the CLIs' own
 * history, as the Usage panel reads it): on mount, when a turn ends and on
 * window focus.
 */
function useChatCost(chat: Chat) {
    const sessionId = chat.harnessSessionId;
    const harness = chat.config.harness;
    const status = useSession(chat.id)?.status;
    const [usage, setUsage] = useState<{ key: string; value: SessionUsage } | null>(null);
    const key = sessionId && harness !== "mock" ? `${harness}\0${sessionId}` : null;
    const lastRead = useRef(0);

    useEffect(() => {
        if (!key || !sessionId) return;
        let live = true;
        const read = (force: boolean) => {
            if (!force && Date.now() - lastRead.current < COST_FRESH_MS) return;
            lastRead.current = Date.now();
            void usageApi
                .session(harness, sessionId)
                .then((value) => live && setUsage({ key, value }))
                .catch(() => {});
        };
        read(true);
        const stop = onWindowFocus(() => read(false));
        return () => {
            live = false;
            stop();
        };
    }, [key, harness, sessionId]);

    // A turn ending wrote its last requests.
    const working = status === "working";
    const wasWorking = useRef(working);
    useEffect(() => {
        const ended = wasWorking.current && !working;
        wasWorking.current = working;
        if (!ended || !key || !sessionId) return;
        lastRead.current = Date.now();
        void usageApi
            .session(harness, sessionId)
            .then((value) => setUsage({ key, value }))
            .catch(() => {});
    }, [working, key, harness, sessionId]);

    return usage?.key === key ? usage.value : null;
}

/** "$3.12", the tokens and models behind it on hover; opens the Usage panel. */
function CostRow({ usage }: { usage: SessionUsage }) {
    const total = costTotal(usage.cost);
    const details = [
        `${formatTokens(processed(usage.tokens))} tokens`,
        `${formatCount(usage.requests)} ${usage.requests === 1 ? "request" : "requests"}`
    ];
    if (usage.unpriced > 0) details.push(`${formatCount(usage.unpriced)} unpriced`);
    return (
        <Row
            icon={<CoinsIcon className="size-4" />}
            label="Cost"
            tooltip={details.join(" · ")}
            onClick={() => useUsageStore.getState().setOpen(true)}
            meta={
                <span className="text-xs font-normal tabular-nums text-dark-200">
                    {formatUsd(total)}
                    {usage.unpriced > 0 && "+"}
                </span>
            }
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
        <SplitRow
            icon={current ? <EditorMark id={current} className="size-4" /> : <CodeIcon className="size-4" />}
            label={`Open in ${current ? EDITORS[current].label : "editor"}`}
            disabled={!current}
            onClick={() => current && void openInEditor(current, folder).catch(() => {})}
            menuLabel="Choose editor"
            menuDisabled={!installed}
            menu={
                <Menu.RadioGroup value={current} onValueChange={(id: string) => setPreferred(id)}>
                    {installed?.map((id) => (
                        <Menu.RadioItem key={id} value={id} className="gap-2">
                            <EditorMark id={id} className="size-4 shrink-0" />
                            {EDITORS[id].label}
                        </Menu.RadioItem>
                    ))}
                </Menu.RadioGroup>
            }
        />
    );
}

/** Fetched quietly when the card shows a checkout, at most this often per folder. */
const AUTO_FETCH_MS = 5 * 60_000;
const autoFetched = new Map<string, number>();

type SyncAction = "fetch" | "pull" | "push";

/**
 * The checked-out branch against its upstream ("↓3 ↑2"). The row does what's
 * due: Publish a branch without an upstream, Pull when behind, Push when
 * ahead, else Fetch; the chevron offers all three. A failure shows under it.
 * Hidden on a detached HEAD.
 */
function SyncRow({ folder, branch }: { folder: string; branch?: GitBranch }) {
    const { busy, error, setError, run } = useGitAction();
    const [running, setRunning] = useState<SyncAction | null>(null);

    // Ahead/behind are only as fresh as the last fetch.
    useEffect(() => {
        if (Date.now() - (autoFetched.get(folder) ?? 0) < AUTO_FETCH_MS) return;
        autoFetched.set(folder, Date.now());
        void git.fetch(folder).catch(() => {});
    }, [folder]);
    // A different folder's error isn't this one's.
    useEffect(() => setError(null), [folder, setError]);

    if (!branch) return null;
    const upstream = branch.upstream;
    const go = (action: SyncAction) => {
        setRunning(action);
        void run(() => git[action](folder)).finally(() => setRunning(null));
    };

    const due: SyncAction = !upstream ? "push" : branch.behind > 0 ? "pull" : branch.ahead > 0 ? "push" : "fetch";
    const RUNNING: Record<SyncAction, string> = {
        fetch: "Fetching…",
        pull: "Pulling…",
        push: upstream ? "Pushing…" : "Publishing…"
    };
    const LABEL: Record<SyncAction, string> = {
        fetch: "Fetch",
        pull: "Pull",
        push: upstream ? "Push" : "Publish branch"
    };
    const ICON: Record<SyncAction, ReactNode> = {
        fetch: <ArrowsClockwiseIcon className="size-4" />,
        pull: <ArrowDownIcon className="size-4" />,
        push: upstream ? <ArrowUpIcon className="size-4" /> : <CloudArrowUpIcon className="size-4" />
    };
    const tooltip = !upstream
        ? `Push ${branch.name} to origin and track it`
        : branch.ahead === 0 && branch.behind === 0
          ? `Up to date with ${upstream}`
          : `${[
                branch.behind > 0 && `${branch.behind} behind`,
                branch.ahead > 0 && `${branch.ahead} ahead`
            ]
                .filter(Boolean)
                .join(" and ")} of ${upstream}`;

    return (
        <>
            <SplitRow
                icon={running ? <DotMatrixSpinner className="size-3.5" /> : ICON[due]}
                label={running ? RUNNING[running] : LABEL[due]}
                tooltip={tooltip}
                disabled={busy}
                onClick={() => go(due)}
                meta={
                    upstream &&
                    (branch.behind > 0 || branch.ahead > 0) && (
                        <span className="flex items-center gap-1.5 text-xs font-normal tabular-nums text-dark-200">
                            {branch.behind > 0 && <span>↓{branch.behind}</span>}
                            {branch.ahead > 0 && <span>↑{branch.ahead}</span>}
                        </span>
                    )
                }
                menuLabel="Sync actions"
                menuDisabled={busy}
                menu={
                    <>
                        <Menu.Item onClick={() => go("fetch")} className="gap-2">
                            <ArrowsClockwiseIcon className="size-3.5" />
                            Fetch
                        </Menu.Item>
                        <Menu.Item onClick={() => go("pull")} disabled={!upstream} className="gap-2">
                            <ArrowDownIcon className="size-3.5" />
                            Pull
                        </Menu.Item>
                        <Menu.Item onClick={() => go("push")} className="gap-2">
                            {upstream ? <ArrowUpIcon className="size-3.5" /> : <CloudArrowUpIcon className="size-3.5" />}
                            {upstream ? "Push" : "Publish branch"}
                        </Menu.Item>
                    </>
                }
            />
            {error && (
                <p className="px-2.5 pt-0.5 pb-1.5 text-[11.5px] leading-snug break-words text-danger">{error}</p>
            )}
        </>
    );
}

/**
 * A row split in two: its own action on the left, a chevron opening `menu`
 * on the right; each half lights on its own.
 */
function SplitRow({
    icon,
    label,
    meta,
    tooltip,
    onClick,
    disabled,
    menuLabel,
    menuDisabled,
    menu
}: {
    icon: ReactNode;
    label: string;
    meta?: ReactNode;
    tooltip?: string;
    onClick: () => void;
    disabled?: boolean;
    menuLabel: string;
    menuDisabled?: boolean;
    menu: ReactNode;
}) {
    const main = (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-s-lg px-2.5 text-left outline-none select-none",
                "text-[13px] font-medium text-dark-100 transition-colors",
                "hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700",
                "disabled:pointer-events-none"
            )}
        >
            <span className="flex size-4 shrink-0 items-center justify-center text-dark-250">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {meta && <span className="flex shrink-0 items-center">{meta}</span>}
        </button>
    );
    return (
        <div className="flex h-8 w-full min-w-0 items-center">
            {tooltip ? (
                <Tooltip>
                    <Tooltip.Trigger render={main} />
                    <Tooltip.Content side="left">{tooltip}</Tooltip.Content>
                </Tooltip>
            ) : (
                main
            )}
            <Menu>
                <Menu.Trigger
                    aria-label={menuLabel}
                    disabled={menuDisabled}
                    className={cn(
                        "flex h-full w-8 shrink-0 items-center justify-center rounded-e-lg text-dark-250 outline-none transition-colors",
                        "hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700",
                        "data-[popup-open]:bg-dark-700 data-[popup-open]:text-dark-50",
                        "disabled:pointer-events-none disabled:opacity-50"
                    )}
                >
                    <CaretDownIcon className="size-3.5" />
                </Menu.Trigger>
                <Menu.Content side="bottom" align="end" className="w-52 min-w-0">
                    {menu}
                </Menu.Content>
            </Menu>
        </div>
    );
}

/**
 * A group of rows, gone while none of them shows; one after a shown section
 * starts under a hairline.
 */
function Section({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section
            aria-label={label}
            className="flex flex-col border-dark-700 p-2 empty:hidden [section:not(:empty)~&]:border-t"
        >
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
    onClick,
    disabled
}: {
    icon: ReactNode;
    label: string;
    meta?: ReactNode;
    tooltip?: string;
    onClick?: () => void;
    /** Dimmed, and `onClick` off. */
    disabled?: boolean;
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
        onClick && "transition-colors hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700",
        "disabled:pointer-events-none disabled:opacity-50"
    );
    const row = onClick ? (
        <button type="button" onClick={onClick} disabled={disabled} className={className}>
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
