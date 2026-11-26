import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import { File, FileDiff, Virtualizer, type FileDiffOptions, type FileOptions } from "@pierre/diffs/react";
import { useSettingsStore } from "@/features/settings/store";
import type { DiffsSettings } from "@/features/settings/types";
import { useLightTheme } from "@/features/theme/useLightTheme";
import { cn } from "@/lib/cn";
import { DIFF_THEMES, lineDiffType } from "./diffs";

/** A file change: its parsed diff and line counts, numbered only when it's a whole file. */
export type FileChange = { diff: FileDiffMetadata; additions: number; deletions: number; numbered: boolean };

/** A file as read: its lines, numbered only when they start at line 1. */
export type FileRead = { file: FileContents; numbered: boolean };

/**
 * The fixed look: the pool's themes (they must match it), no file header
 * (the tool line names the file), the app's surface and code font, no
 * hover highlight (nothing in the transcript reacts to a click).
 */
const BASE = {
    theme: DIFF_THEMES,
    disableFileHeader: true,
    lineHoverHighlight: "disabled",
    unsafeCSS:
        ":host { --diffs-light-bg: var(--surface); --diffs-dark-bg: var(--surface); --diffs-font-family: var(--font-mono); --diffs-font-size: 12px; }"
} as const;

/** Options by everything they depend on, kept stable so the views don't redraw. */
const diffOptions = new Map<string, FileDiffOptions<undefined, undefined>>();
const fileOptions = new Map<string, FileOptions<undefined, undefined>>();

function shared(light: boolean, numbered: boolean, diffs: DiffsSettings) {
    return {
        ...BASE,
        themeType: light ? "light" : "dark",
        disableLineNumbers: !numbered,
        overflow: diffs.wrapLines ? "wrap" : "scroll"
    } as const;
}

function useDiffOptions(numbered: boolean) {
    const diffs = useSettingsStore((s) => s.settings.diffs);
    const light = useLightTheme();
    const key = `${light}|${numbered}|${diffs.wrapLines}|${diffs.indicators}|${diffs.inlineChanges}`;
    let options = diffOptions.get(key);
    if (!options) {
        options = {
            ...shared(light, numbered, diffs),
            diffStyle: "unified",
            diffIndicators: diffs.indicators,
            lineDiffType: lineDiffType(diffs.inlineChanges)
        };
        diffOptions.set(key, options);
    }
    return options;
}

function useFileOptions(numbered: boolean) {
    const diffs = useSettingsStore((s) => s.settings.diffs);
    const light = useLightTheme();
    const key = `${light}|${numbered}|${diffs.wrapLines}`;
    let options = fileOptions.get(key);
    if (!options) {
        options = shared(light, numbered, diffs);
        fileOptions.set(key, options);
    }
    return options;
}

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
