import type { ReactNode } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { ArrowUUpLeftIcon, ArrowSquareOutIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useDiffOptions } from "@/features/chat/transcript/useDiffOptions";
import { openFileTab } from "@/features/editor/open";
import { useSettingsStore } from "@/features/settings/store";
import { cn } from "@/lib/cn";
import { FileIcon, IconButton, Tooltip } from "@/ui";
import type { Changed } from "./patchFiles";

/*
 * A patch shown a file at a time, as the changes and commit tabs show it:
 * a sticky header per file (a press collapses it) over its diff.
 */

export function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
    return (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
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

/** One file: a sticky header (a press collapses it) over its diff. Given `onRevert`, the header offers to undo the file's changes. */
export function FileSection({
    file,
    root,
    collapsed,
    onToggle,
    onRevert
}: {
    file: Changed;
    root: string;
    collapsed: boolean;
    onToggle: () => void;
    onRevert?: () => void;
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
                {onRevert && (
                    <IconButton
                        label="Undo this file's changes"
                        onClick={(event) => {
                            event.stopPropagation();
                            onRevert();
                        }}
                        className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
                    >
                        <ArrowUUpLeftIcon className="size-3.5" />
                    </IconButton>
                )}
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

export function Centered({ children }: { children: ReactNode }) {
    return <div className="flex min-h-0 flex-1 items-center justify-center text-muted">{children}</div>;
}

export function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
    return (
        <Centered>
            <div className="flex max-w-64 flex-col items-center gap-2 px-4 text-center text-xs">
                <span className="text-muted">{icon}</span>
                <span>{children}</span>
            </div>
        </Centered>
    );
}
