import type { FileDiffOptions, FileOptions } from "@pierre/diffs/react";
import { useSettingsStore } from "@/features/settings/store";
import type { DiffsSettings } from "@/features/settings/types";
import { useLightTheme } from "@/features/theme/useLightTheme";
import { DIFF_THEMES, lineDiffType } from "./diffs";

/** What a diff sits on: the transcript's surface, or a panel's background. */
export type DiffBackground = "surface" | "bg";

/**
 * The fixed look: the pool's themes (they must match it), no file header
 * (the tool line or the caller names the file), the app's code font, no
 * hover highlight (nothing in the transcript reacts to a click).
 */
const base = (background: DiffBackground) =>
    ({
        theme: DIFF_THEMES,
        disableFileHeader: true,
        lineHoverHighlight: "disabled",
        unsafeCSS: `:host { --diffs-light-bg: var(--${background}); --diffs-dark-bg: var(--${background}); --diffs-font-family: var(--font-mono); --diffs-font-size: 12px; }`
    }) as const;

/** Options by everything they depend on, kept stable so the views don't redraw. */
const diffOptions = new Map<string, FileDiffOptions<undefined, undefined>>();
const fileOptions = new Map<string, FileOptions<undefined, undefined>>();

function shared(light: boolean, numbered: boolean, diffs: DiffsSettings, background: DiffBackground = "surface") {
    return {
        ...base(background),
        themeType: light ? "light" : "dark",
        disableLineNumbers: !numbered,
        overflow: diffs.wrapLines ? "wrap" : "scroll"
    } as const;
}

/** A diff's options from the diff settings and the theme; the same object while they hold. */
export function useDiffOptions(
    numbered: boolean,
    { style = "unified", background = "surface" }: { style?: "unified" | "split"; background?: DiffBackground } = {}
) {
    const diffs = useSettingsStore((s) => s.settings.diffs);
    const light = useLightTheme();
    const key = `${light}|${numbered}|${style}|${background}|${diffs.wrapLines}|${diffs.indicators}|${diffs.inlineChanges}`;
    let options = diffOptions.get(key);
    if (!options) {
        options = {
            ...shared(light, numbered, diffs, background),
            diffStyle: style,
            diffIndicators: diffs.indicators,
            lineDiffType: lineDiffType(diffs.inlineChanges)
        };
        diffOptions.set(key, options);
    }
    return options;
}

/** A file view's options; the same object while what they depend on holds. */
export function useFileOptions(numbered: boolean) {
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
