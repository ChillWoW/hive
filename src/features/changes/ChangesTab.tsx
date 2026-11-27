import { useMemo, useState, type ReactNode } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import {
    ArrowClockwiseIcon,
    ArrowSquareOutIcon,
    CaretRightIcon,
    GitDiffIcon,
    WarningIcon
} from "@phosphor-icons/react";
import { useDiffOptions } from "@/features/chat/transcript/useDiffOptions";
import { openFileTab } from "@/features/editor/open";
import { panelTabs } from "@/features/panel-tabs/store";
import { useSettingsStore } from "@/features/settings/store";
import { isShortcutOf } from "@/keybindings";
import { cn } from "@/lib/cn";
import { CollapseAllIcon, DotMatrixSpinner, FileIcon, IconButton, Tooltip } from "@/ui";
import { useChanges } from "./useChanges";

/** A changed file: its parsed diff and line counts. */
type Changed = { diff: FileDiffMetadata; additions: number; deletions: number };

function parse(patch: string): Changed[] {
    if (!patch.trim()) return [];
    const files = parsePatchFiles(patch).flatMap((p) => p.files);
    return files.map((diff) => {
        let additions = 0;
        let deletions = 0;
        for (const hunk of diff.hunks) {
            additions += hunk.additionLines;
            deletions += hunk.deletionLines;
        }
        return { diff, additions, deletions };
    });
}

/** A diff tab: the uncommitted changes in `cwd`'s checkout, a file at a time. */
export function ChangesTab({ id, cwd }: { id: string; cwd: string }) {
    const { changes, error, loading, refresh } = useChanges(cwd);
    const patch = changes?.patch ?? "";
    const files = useMemo(() => parse(patch), [patch]);
    // Collapsed files by name; a file that comes back keeps its state.
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const allCollapsed = files.length > 0 && files.every((f) => collapsed[f.diff.name]);

    const toggle = (name: string) => setCollapsed((c) => ({ ...c, [name]: !c[name] }));
    const toggleAll = () =>
        setCollapsed(allCollapsed ? {} : Object.fromEntries(files.map((f) => [f.diff.name, true])));

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
                        collapsed={!!collapsed[file.diff.name]}
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

function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
    return (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
            {additions > 0 && <span className="text-success">+{additions}</span>}
            {deletions > 0 && <span className="text-danger">−{deletions}</span>}
        </span>
    );
}

const STATUS: Partial<Record<FileDiffMetadata["type"], { label: string; className: string }>> = {
    new: { label: "Added", className: "text-success" },
    deleted: { label: "Deleted", className: "text-danger" },
    "rename-pure": { label: "Renamed", className: "text-info" },
    "rename-changed": { label: "Renamed", className: "text-info" }
};

/** One file: a sticky header (a press collapses it) over its diff. */
function FileSection({
    file,
    root,
    collapsed,
    onToggle
}: {
    file: Changed;
    root: string;
    collapsed: boolean;
    onToggle: () => void;
}) {
    const style = useSettingsStore((s) => s.settings.diffs.style);
    const options = useDiffOptions(true, { style, background: "bg" });
    const { diff } = file;
    const slash = diff.name.lastIndexOf("/");
    const folder = slash < 0 ? "" : diff.name.slice(0, slash + 1);
    const name = diff.name.slice(slash + 1);
    const status = STATUS[diff.type];
    const empty = diff.hunks.length === 0;

    return (
        <section className="border-b border-border">
            <div
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                onClick={onToggle}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onToggle();
                }}
                className={cn(
                    "group/file sticky top-0 z-10 flex h-8 cursor-default items-center gap-1.5 bg-bg pr-1.5 pl-2 text-xs",
                    "outline-none hover:bg-raised focus-visible:bg-raised",
                    !collapsed && "border-b border-border"
                )}
            >
                <CaretRightIcon
                    className={cn("size-3 shrink-0 text-muted transition-transform duration-150", !collapsed && "rotate-90")}
                />
                <FileIcon name={name} className="size-3.5" />
                <Tooltip disableHoverablePopup>
                    <Tooltip.Trigger
                        delay={600}
                        render={
                            <div className="flex min-w-0 flex-1 items-baseline">
                                {folder && <span className="min-w-0 truncate text-muted">{folder}</span>}
                                <span className="shrink-0 font-medium text-text">{name}</span>
                            </div>
                        }
                    />
                    <Tooltip.Content side="bottom">
                        {diff.prevName ? `${diff.prevName} → ${diff.name}` : diff.name}
                    </Tooltip.Content>
                </Tooltip>
                {status && <span className={cn("shrink-0 text-[11px]", status.className)}>{status.label}</span>}
                <LineCounts additions={file.additions} deletions={file.deletions} />
                {diff.type !== "deleted" && (
                    <IconButton
                        label="Open file"
                        onClick={(event) => {
                            event.stopPropagation();
                            openFileTab(root, diff.name);
                        }}
                        className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
                    >
                        <ArrowSquareOutIcon className="size-3.5" />
                    </IconButton>
                )}
            </div>
            {!collapsed &&
                (empty ? (
                    <p className="px-3 py-2.5 text-xs text-muted">
                        {diff.type === "rename-pure"
                            ? `Renamed from ${diff.prevName ?? "another path"}, unchanged.`
                            : "A binary file, or only its mode changed."}
                    </p>
                ) : (
                    <FileDiff fileDiff={diff} options={options} />
                ))}
        </section>
    );
}

function Centered({ children }: { children: ReactNode }) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-muted">{children}</div>;
}

function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <Centered>
            <div className="flex max-w-64 flex-col items-center gap-2 px-4 text-center text-xs">
                <span className="text-muted">{icon}</span>
                <span>{children}</span>
            </div>
        </Centered>
    );
}
