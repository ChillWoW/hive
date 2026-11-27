import type { ITerminalOptions } from "@xterm/xterm";
import { cssFontFamily } from "@/features/fonts/store";
import type { TerminalSettings } from "@/features/settings/types";
import type { Theme } from "@/features/theme/themes";
import { terminalTheme } from "./theme";

/** After the code font, or in its place: monospace fonts most systems have. */
const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';

/**
 * The terminal settings as xterm options, in the code font
 * (`appearance.codeFontFamily`) and the app's theme. A canvas can't read CSS
 * variables, so the family is spelled out.
 */
export function terminalOptions(terminal: TerminalSettings, codeFont: string, theme: Theme): ITerminalOptions {
    return {
        fontFamily: codeFont ? `${cssFontFamily(codeFont)}, ${MONO_FALLBACK}` : MONO_FALLBACK,
        fontSize: terminal.fontSize,
        lineHeight: terminal.lineHeight,
        cursorStyle: terminal.cursorStyle,
        cursorInactiveStyle: "outline",
        cursorBlink: terminal.cursorBlink,
        scrollback: terminal.scrollback,
        macOptionIsMeta: terminal.optionAsMeta,
        theme: terminalTheme(theme)
    };
}
