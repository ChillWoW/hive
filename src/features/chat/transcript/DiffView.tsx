import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import { File, FileDiff, Virtualizer } from "@pierre/diffs/react";
import { cn } from "@/lib/cn";
import { useDiffOptions, useFileOptions } from "./useDiffOptions";

/** A file change: its parsed diff and line counts, numbered only when it's a whole file. */
export type FileChange = { diff: FileDiffMetadata; additions: number; deletions: number; numbered: boolean };

/** A file as read: its lines, numbered only when they start at line 1. */
export type FileRead = { file: FileContents; numbered: boolean };

const FRAME = "max-h-80 overflow-y-auto rounded-md bg-surface";

/** A file change, unified. Scrolls past 20rem, drawing only the lines in view. */
export function DiffView({ change, className }: { change: FileChange; className?: string }) {
    const options = useDiffOptions(change.numbered);
    return (
        <Virtualizer className={cn(FRAME, className)}>
            <FileDiff fileDiff={change.diff} options={options} />
        </Virtualizer>
    );
}

/** A file as read. Scrolls past 20rem, drawing only the lines in view. */
export function FileView({ read, className }: { read: FileRead; className?: string }) {
    const options = useFileOptions(read.numbered);
    return (
        <Virtualizer className={cn(FRAME, className)}>
            <File file={read.file} options={options} />
        </Virtualizer>
    );
}
