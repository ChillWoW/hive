import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import { File, FileDiff, Virtualizer, type FileDiffOptions, type FileOptions } from "@pierre/diffs/react";
import { useLightTheme } from "@/features/theme/useLightTheme";
import { cn } from "@/lib/cn";
import { DIFF_THEMES } from "./diffsPool";

/** A file change: its parsed diff and line counts, numbered only when it's a whole file. */
export type FileChange = { diff: FileDiffMetadata; additions: number; deletions: number; numbered: boolean };

/** A file as read: its lines, numbered only when they start at line 1. */
export type FileRead = { file: FileContents; numbered: boolean };

/** The pool's themes (they must match it); the app's surface behind them. */
const BASE = {
    theme: DIFF_THEMES,
    disableFileHeader: true,
    overflow: "scroll",
    unsafeCSS: ":host { --diffs-light-bg: var(--surface); --diffs-dark-bg: var(--surface); --diffs-font-size: 12px; }"
} as const;

/** Options by light/dark and numbered, kept stable so the views don't redraw. */
const DIFF_OPTIONS = new Map<string, FileDiffOptions<undefined, undefined>>();
const FILE_OPTIONS = new Map<string, FileOptions<undefined, undefined>>();

function optionsOf<T>(cache: Map<string, T>, light: boolean, numbered: boolean, extra: object): T {
    const key = `${light}|${numbered}`;
    let options = cache.get(key);
    if (!options) {
        options = { ...BASE, ...extra, themeType: light ? "light" : "dark", disableLineNumbers: !numbered } as T;
        cache.set(key, options);
    }
    return options;
}

const FRAME = "max-h-80 overflow-y-auto rounded-md bg-surface";

/** A file change, unified. Scrolls past 20rem, drawing only the lines in view. */
export function DiffView({ change, className }: { change: FileChange; className?: string }) {
    const options = optionsOf(DIFF_OPTIONS, useLightTheme(), change.numbered, { diffStyle: "unified" });
    return (
        <Virtualizer className={cn(FRAME, className)}>
            <FileDiff fileDiff={change.diff} options={options} />
        </Virtualizer>
    );
}

/** A file as read. Scrolls past 20rem, drawing only the lines in view. */
export function FileView({ read, className }: { read: FileRead; className?: string }) {
    const options = optionsOf(FILE_OPTIONS, useLightTheme(), read.numbered, {});
    return (
        <Virtualizer className={cn(FRAME, className)}>
            <File file={read.file} options={options} />
        </Virtualizer>
    );
}
