import { useMemo, type ReactNode } from "react";
import { Virtualizer } from "@pierre/diffs/react";
import { ArrowClockwiseIcon, GitDiffIcon, WarningIcon } from "@phosphor-icons/react";
import { panelTabs } from "@/features/panel-tabs/store";
import { isShortcutOf } from "@/keybindings";
import { cn } from "@/lib/cn";
import { CollapseAllIcon, DotMatrixSpinner, IconButton, Tooltip } from "@/ui";
import { Centered, FileSection, LineCounts, Notice } from "./DiffFiles";
import { parsePatch, useCollapsedFiles, type Changed } from "./patchFiles";
import { useChanges } from "./useChanges";

/** A diff tab: the uncommitted changes in `cwd`'s checkout, a file at a time. */
export function ChangesTab({ id, cwd }: { id: string; cwd: string }) {
    const { changes, error, loading, refresh } = useChanges(cwd);
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
        body = <Notice icon={<GitDiffIcon className="size-5" />}>Not in a git repository.</Notice>;
    } else if (files.length === 0) {
        body = <Notice icon={<GitDiffIcon className="size-5" />}>No uncommitted changes.</Notice>;
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
                loading={loading}
                error={changes !== undefined ? error : null}
                allCollapsed={allCollapsed}
                onToggleAll={toggleAll}
                onRefresh={refresh}
            />
            {body}
        </div>
    );
}

function Toolbar({
    files,
    loading,
    error,
    allCollapsed,
    onToggleAll,
    onRefresh
}: {
    files: Changed[];
    loading: boolean;
    /** A refresh that failed while older changes are still shown. */
    error: string | null;
    allCollapsed: boolean;
    onToggleAll: () => void;
    onRefresh: () => void;
}) {
    const additions = files.reduce((sum, f) => sum + f.additions, 0);
    const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1.5 pl-3">
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
                <span className="truncate font-medium text-text">
                    {files.length === 0
                        ? "Changes"
                        : `${files.length} ${files.length === 1 ? "file" : "files"} changed`}
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
