import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Virtualizer } from "@pierre/diffs/react";
import { ClockCounterClockwiseIcon, GitCommitIcon, WarningIcon } from "@phosphor-icons/react";
import { Centered, FileSection, LineCounts, Notice } from "@/features/changes/DiffFiles";
import { parsePatch, useCollapsedFiles, type Changed } from "@/features/changes/patchFiles";
import { panelTabs } from "@/features/panel-tabs/store";
import { isShortcutOf } from "@/keybindings";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { agoLabel, useMinuteClock } from "@/lib/time";
import type { GitCommitDetail } from "@/proto";
import { CollapseAllIcon, DotMatrixSpinner, IconButton, Tooltip } from "@/ui";
import { historyApi } from "./api";
import { commitTabLabels, openCommitTab, openHistoryTab } from "./open";
import { formatFull, parseTime } from "./display";
import { AuthorAvatar, HashButton, RefBadge } from "./parts";
import { useHistoryEntry } from "./store";

/** Read commits, by folder and hash: a commit never changes. */
const cache = new Map<string, Promise<GitCommitDetail | null>>();

function readCommit(cwd: string, sha: string) {
    const key = `${cwd}\0${sha}`;
    let request = cache.get(key);
    if (!request) {
        request = historyApi.commitDetail(cwd, sha);
        // A failure is tried again next time.
        request.catch(() => cache.delete(key));
        cache.set(key, request);
    }
    return request;
}

/**
 * A commit tab: one commit of `cwd`'s checkout, its message, author and
 * parents over what it changed against its first parent, a file at a time.
 */
export function CommitTab({ id, cwd, sha }: { id: string; cwd: string; sha: string }) {
    const [state, setState] = useState<{ detail?: GitCommitDetail | null; error?: string }>({});

    useEffect(() => {
        let live = true;
        readCommit(cwd, sha).then(
            (detail) => {
                if (!live) return;
                setState({ detail });
                // Opened by hash alone (a parent): named once its subject is known.
                if (detail) panelTabs.update(id, commitTabLabels(cwd, sha, detail.commit.subject));
            },
            (error) => live && setState({ error: errorMessage(error, "Git failed.") })
        );
        return () => {
            live = false;
        };
    }, [id, cwd, sha]);

    const detail = state.detail;
    const files = useMemo(() => parsePatch(detail?.patch ?? ""), [detail]);
    const { isCollapsed, allCollapsed, toggle, toggleAll } = useCollapsedFiles(files);

    let body: ReactNode;
    if (state.error) {
        body = <Notice icon={<WarningIcon className="size-5 text-warning" />}>{state.error}</Notice>;
    } else if (detail === undefined) {
        body = (
            <Centered>
                <DotMatrixSpinner label="Reading the commit" />
            </Centered>
        );
    } else if (detail === null) {
        body = <Notice icon={<GitCommitIcon className="size-5" />}>Not in a git repository any more.</Notice>;
    } else {
        body = (
            <Virtualizer className="min-h-0 flex-1 overflow-y-auto">
                <CommitHeader id={id} cwd={cwd} detail={detail} />
                {files.map((file) => (
                    <FileSection
                        key={file.diff.name}
                        file={file}
                        root={detail.root}
                        collapsed={isCollapsed(file.diff.name)}
                        onToggle={() => toggle(file.diff.name)}
                    />
                ))}
                {files.length === 0 && !detail.truncated && (
                    <p className="px-3 py-3 text-xs text-muted">This commit changes no files.</p>
                )}
                {detail.truncated && (
                    <p className="px-3 py-3 text-xs text-muted">
                        {files.length === 0 ? "This commit is" : "The rest of this commit is"} too big to show.
                    </p>
                )}
            </Virtualizer>
        );
    }

    return (
        <div
            // Focusable, so the close-tab shortcut closes this tab, not the chat's.
            tabIndex={-1}
            onKeyDown={(event) => {
                if (!isShortcutOf(event.nativeEvent, "closeTab")) return;
                event.preventDefault();
                panelTabs.close(id);
            }}
            className="flex min-h-0 flex-1 flex-col outline-none"
        >
            <Toolbar
                cwd={cwd}
                sha={detail?.commit.sha ?? sha}
                files={files}
                allCollapsed={allCollapsed}
                onToggleAll={toggleAll}
            />
            {body}
        </div>
    );
}

function Toolbar({
    cwd,
    sha,
    files,
    allCollapsed,
    onToggleAll
}: {
    cwd: string;
    sha: string;
    files: Changed[];
    allCollapsed: boolean;
    onToggleAll: () => void;
}) {
    const additions = files.reduce((sum, f) => sum + f.additions, 0);
    const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                <HashButton sha={sha} className="-ml-1.5" />
                {files.length > 0 && (
                    <>
                        <span className="truncate text-muted">
                            {files.length} {files.length === 1 ? "file" : "files"} changed
                        </span>
                        <LineCounts additions={additions} deletions={deletions} />
                    </>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                <IconButton label="Show in history" shortcut="showHistory" onClick={() => openHistoryTab(cwd)}>
                    <ClockCounterClockwiseIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label={allCollapsed ? "Expand all" : "Collapse all"}
                    disabled={files.length === 0}
                    onClick={onToggleAll}
                >
                    <CollapseAllIcon className="size-3.5" />
                </IconButton>
            </div>
        </div>
    );
}

/** Past this many lines, a message's body folds until asked. */
const BODY_LINES = 8;

/** The commit's message, who made it and when, its refs and parents. */
function CommitHeader({ id, cwd, detail }: { id: string; cwd: string; detail: GitCommitDetail }) {
    const { commit, body } = detail;
    const avatars = useHistoryEntry(cwd).avatars;
    const now = useMinuteClock();
    const [expanded, setExpanded] = useState(false);
    const long = body.split("\n").length > BODY_LINES || body.length > 600;
    const author = commit.authorName.trim() || "Unknown";
    const authored = parseTime(commit.authoredAt);
    const committed = parseTime(detail.committedAt);
    const committer = detail.committerName.trim();
    const otherCommitter = committer && committer !== author;
    const merge = commit.parentShas.length > 1;

    return (
        <header className="flex flex-col gap-2.5 border-b border-border px-3 py-3 select-text">
            <h2 className={cn("text-[13px] leading-snug font-medium", commit.subject ? "text-text" : "text-muted italic")}>
                {commit.subject || "No message"}
            </h2>
            {body && (
                <div className="flex flex-col items-start gap-1">
                    <p
                        className={cn(
                            "text-xs leading-relaxed break-words whitespace-pre-wrap text-muted",
                            long && !expanded && "line-clamp-[8]"
                        )}
                    >
                        {body}
                    </p>
                    {long && (
                        <button
                            type="button"
                            onClick={() => setExpanded((e) => !e)}
                            className="rounded-sm text-xs text-muted outline-none hover:text-text focus-visible:text-text"
                        >
                            {expanded ? "Show less" : "Show more"}
                        </button>
                    )}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                <AuthorAvatar name={author} url={avatars[commit.authorEmail.trim().toLowerCase()]} />
                <Tooltip disableHoverablePopup disabled={!commit.authorEmail}>
                    <Tooltip.Trigger delay={400} render={<span className="font-medium text-text">{author}</span>} />
                    <Tooltip.Content side="bottom">{commit.authorEmail}</Tooltip.Content>
                </Tooltip>
                {authored !== undefined && <When verb="authored" at={authored} now={now} />}
                {otherCommitter && (
                    <>
                        <span aria-hidden>·</span>
                        <span>
                            committed by <span className="text-text">{committer}</span>
                        </span>
                        {committed !== undefined && <When at={committed} now={now} />}
                    </>
                )}
            </div>
            {(commit.refs.length > 0 || commit.parentShas.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    {commit.refs.map((ref) => (
                        <RefBadge key={`${ref.kind}:${ref.label}`} gitRef={ref} />
                    ))}
                    {commit.parentShas.length > 0 && (
                        <span className={cn("flex items-center gap-1", commit.refs.length > 0 && "ml-1")}>
                            {merge ? "Merges" : "Parent"}
                            {commit.parentShas.map((parent, i) => (
                                <span key={parent} className="flex items-center gap-1">
                                    {i > 0 && <span aria-hidden>+</span>}
                                    <ParentButton
                                        sha={parent}
                                        onOpen={(fresh) => openCommitTab(cwd, { sha: parent }, { fresh, into: id })}
                                    />
                                </span>
                            ))}
                        </span>
                    )}
                </div>
            )}
        </header>
    );
}

function When({ verb, at, now }: { verb?: string; at: number; now: number }) {
    return (
        <Tooltip disableHoverablePopup>
            <Tooltip.Trigger
                delay={400}
                render={
                    <span>
                        {verb && `${verb} `}
                        {agoLabel(at, now)}
                    </span>
                }
            />
            <Tooltip.Content side="bottom">{formatFull(at)}</Tooltip.Content>
        </Tooltip>
    );
}

/** A parent's short hash: opens it here, or (with ⌘/Ctrl) in a new tab. */
function ParentButton({ sha, onOpen }: { sha: string; onOpen: (fresh: boolean) => void }) {
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        onClick={(event) => onOpen(event.metaKey || event.ctrlKey)}
                        onAuxClick={(event) => event.button === 1 && onOpen(true)}
                        className={cn(
                            "inline-flex h-5 items-center rounded bg-raised px-1.5 font-mono text-[11px] text-muted outline-none",
                            "transition-colors hover:bg-hover hover:text-text focus-visible:bg-hover"
                        )}
                    >
                        {sha.slice(0, 7)}
                    </button>
                }
            />
            <Tooltip.Content side="bottom">Show this commit</Tooltip.Content>
        </Tooltip>
    );
}
