import type { ReactNode } from "react";
import {
    ArrowsInLineVerticalIcon,
    ArrowsOutLineVerticalIcon,
    ColumnsIcon,
    TextAlignLeftIcon
} from "@phosphor-icons/react";
import { FileSection, LineCounts } from "@/diff/DiffFiles";
import { totals, type FileDiff } from "@/diff/patch";
import { useDiffPrefs } from "@/diff/store";
import { Tooltip } from "@/ui";
import type { Folds } from "./folds";
import { ToolButton } from "./parts";

/*
 * What the diff and commit tabs share: the split / wrap / collapse-all
 * buttons, the summary strip and the list of file sections (folded by
 * `useFolds`).
 */

/** The toolbar's split, wrap and collapse-all buttons. */
export function ViewButtons({ folds }: { folds: Folds }) {
    const split = useDiffPrefs((s) => s.split);
    const wrap = useDiffPrefs((s) => s.wrap);
    const toggleSplit = useDiffPrefs((s) => s.toggleSplit);
    const toggleWrap = useDiffPrefs((s) => s.toggleWrap);
    return (
        <>
            <ToolButton label={split ? "Unified view" : "Split view"} pressed={split} onClick={toggleSplit}>
                <ColumnsIcon className="size-3.5" />
            </ToolButton>
            <ToolButton label={wrap ? "Don't wrap lines" : "Wrap lines"} pressed={wrap} onClick={toggleWrap}>
                <TextAlignLeftIcon className="size-3.5" />
            </ToolButton>
            <ToolButton
                label={folds.allFolded ? "Expand all" : "Collapse all"}
                disabled={folds.empty}
                onClick={folds.toggleAll}
            >
                {folds.allFolded ? (
                    <ArrowsOutLineVerticalIcon className="size-3.5" />
                ) : (
                    <ArrowsInLineVerticalIcon className="size-3.5" />
                )}
            </ToolButton>
        </>
    );
}

/**
 * The strip over the files: `label`, the lines added and removed, a
 * `partial` badge when the patch was cut short, then `children` (actions).
 */
export function ChangesSummary({
    label,
    files,
    partial,
    children
}: {
    label: string;
    files: FileDiff[];
    /** The badge's text, shown when the patch was too large to read whole. */
    partial?: string;
    children?: ReactNode;
}) {
    const sum = totals(files);
    return (
        <div className="flex h-8 shrink-0 items-center gap-2.5 border-b border-dark-600 px-4 text-[11.5px]">
            <span className="min-w-0 truncate text-dark-200">{label}</span>
            <LineCounts additions={sum.additions} deletions={sum.deletions} className="text-[11px]" />
            <span className="flex-1" />
            {partial && (
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning/80">
                                {partial}
                            </span>
                        }
                    />
                    <Tooltip.Content side="bottom">
                        Too large to show whole; some changes are left out.
                    </Tooltip.Content>
                </Tooltip>
            )}
            {children}
        </div>
    );
}

/** The files' sections, scrolling; a deleted file can't be opened. */
export function FileList({
    files,
    folds,
    onOpen,
    onRevert
}: {
    files: FileDiff[];
    folds: Folds;
    onOpen: (path: string) => void;
    onRevert?: (file: FileDiff) => void;
}) {
    const split = useDiffPrefs((s) => s.split);
    const wrap = useDiffPrefs((s) => s.wrap);
    return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {files.map((file, i) => (
                <FileSection
                    key={file.path}
                    file={file}
                    first={i === 0}
                    folded={folds.isFolded(file)}
                    split={split}
                    wrap={wrap}
                    onToggle={folds.toggle}
                    onOpen={file.status === "deleted" ? undefined : onOpen}
                    onRevert={onRevert}
                />
            ))}
        </div>
    );
}
