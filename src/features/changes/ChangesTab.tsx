import { useMemo, useState, type ReactNode } from "react";
import { Virtualizer } from "@pierre/diffs/react";
import { ArrowClockwiseIcon, ArrowUUpLeftIcon, GitDiffIcon, WarningIcon } from "@phosphor-icons/react";
import { useWorking } from "@/features/chats/store";
import { panelTabs } from "@/features/panel-tabs/store";
import { isShortcutOf } from "@/keybindings";
import { cn } from "@/lib/cn";
import { CollapseAllIcon, DotMatrixSpinner, IconButton, Tooltip } from "@/ui";
import { Centered, FileSection, LineCounts, Notice } from "./DiffFiles";
import { parsePatch, useCollapsedFiles, type Changed } from "./patchFiles";
import { RevertTurnDialog } from "./RevertTurnDialog";
import { useTurnChanges, type RevertRequest } from "./turn";
import { useChanges, type ChangesState } from "./useChanges";

/**
 * A diff tab, a file at a time: the uncommitted changes in `cwd`'s checkout,
 * or with `chatId` what that chat's latest turn changed there, which can be
 * undone (all of it, or a file).
 */
export function ChangesTab({ id, cwd, chatId }: { id: string; cwd: string; chatId?: string }) {
    return chatId ? <TurnTab id={id} cwd={cwd} chatId={chatId} /> : <UncommittedTab id={id} cwd={cwd} />;
}

function UncommittedTab({ id, cwd }: { id: string; cwd: string }) {
    return <ChangesView id={id} state={useChanges(cwd)} empty="No uncommitted changes." />;
}

function TurnTab({ id, cwd, chatId }: { id: string; cwd: string; chatId: string }) {
    const state = useTurnChanges(chatId);
    const working = useWorking(chatId);
    const [revert, setRevert] = useState<RevertRequest | null>(null);
    return (
        <>
            <ChangesView
                id={id}
                state={state}
                turn
                unrecorded="No turn recorded yet. What this chat's next prompt changes shows here."
                empty={working ? "This turn hasn't changed any files yet." : "The last turn changed no files."}
                // The agent's edits would land on top of a half-undone turn.
                onRevert={working ? undefined : (files, whole) => setRevert({ chatId, cwd, files, whole })}
            />
            <RevertTurnDialog request={revert} onClose={() => setRevert(null)} />
        </>
    );
}

function ChangesView({
    id,
    state,
    turn = false,
    unrecorded = "Not in a git repository.",
    empty,
    onRevert
}: {
    id: string;
    state: ChangesState;
    /** A turn's changes, rather than the uncommitted ones. */
    turn?: boolean;
    /** What to say when there are no changes to read at all. */
    unrecorded?: string;
    /** What to say when nothing changed. */
    empty: string;
    /** Undoes `files`: all of them (`whole`), or one. */
    onRevert?: (files: Changed[], whole: boolean) => void;
}) {
    const { changes, error, loading, refresh } = state;
    const patch = changes?.patch ?? "";
    const files = useMemo(() => parsePatch(patch), [patch]);
    const { isCollapsed, allCollapsed, toggle, toggleAll } = useCollapsedFiles(files);

    let body: ReactNode;
    if (changes === undefined && !error) {
        body = (
            <Centered>
                <DotMatrixSpinner label="Reading changes" />
            </Centered>
        );
    } else if (error && changes === undefined) {
        body = <Notice icon={<WarningIcon className="size-5 text-warning" />}>{error}</Notice>;
    } else if (changes === null) {
        body = <Notice icon={<GitDiffIcon className="size-5" />}>{unrecorded}</Notice>;
    } else if (files.length === 0) {
        body = <Notice icon={<GitDiffIcon className="size-5" />}>{empty}</Notice>;
    } else {
        body = (
            <Virtualizer className="min-h-0 flex-1 overflow-y-auto">
                {files.map((file) => (
                    <FileSection
                        key={file.diff.name}
                        file={file}
                        root={changes!.root}
                        collapsed={isCollapsed(file.diff.name)}
                        onToggle={() => toggle(file.diff.name)}
                        onRevert={onRevert && (() => onRevert([file], false))}
                    />
                ))}
                {!!changes?.skipped && (
                    <p className="px-3 py-3 text-xs text-muted">
                        {changes.skipped} untracked {changes.skipped === 1 ? "file isn't" : "files aren't"} shown
                        (too many, or too big).
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
                files={files}
                turn={turn}
                loading={loading}
                error={changes !== undefined ? error : null}
                allCollapsed={allCollapsed}
                onToggleAll={toggleAll}
                onRefresh={refresh}
                onRevert={turn ? onRevert && (() => onRevert(files, true)) : undefined}
            />
            {body}
        </div>
    );
}

function Toolbar({
    files,
    turn,
    loading,
    error,
    allCollapsed,
    onToggleAll,
    onRefresh,
    onRevert
}: {
    files: Changed[];
    turn: boolean;
    loading: boolean;
    /** A refresh that failed while older changes are still shown. */
    error: string | null;
    allCollapsed: boolean;
    onToggleAll: () => void;
    onRefresh: () => void;
    /** Undoes every file; a turn's tab without it has its undo off. */
    onRevert?: () => void;
}) {
    const additions = files.reduce((sum, f) => sum + f.additions, 0);
    const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
    const count = `${files.length} ${files.length === 1 ? "file" : "files"} changed`;

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                <span className="truncate font-medium text-text">
                    {files.length === 0 ? (turn ? "Last turn" : "Changes") : turn ? `${count} last turn` : count}
                </span>
                {files.length > 0 && <LineCounts additions={additions} deletions={deletions} />}
                {error && (
                    <Tooltip>
                        <Tooltip.Trigger render={<WarningIcon className="size-3.5 shrink-0 text-warning" />} />
                        <Tooltip.Content side="bottom">{error}</Tooltip.Content>
                    </Tooltip>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                {turn && (
                    <IconButton
                        label="Undo the turn's changes"
                        disabled={!onRevert || files.length === 0}
                        onClick={onRevert}
                    >
                        <ArrowUUpLeftIcon className="size-3.5" />
                    </IconButton>
                )}
                <IconButton
                    label={allCollapsed ? "Expand all" : "Collapse all"}
                    disabled={files.length === 0}
                    onClick={onToggleAll}
                >
                    <CollapseAllIcon className="size-3.5" />
                </IconButton>
                <IconButton label="Refresh" onClick={onRefresh}>
                    <ArrowClockwiseIcon className={cn("size-3.5", loading && "animate-spin")} />
                </IconButton>
            </div>
        </div>
    );
}
