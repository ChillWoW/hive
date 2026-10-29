import type { ITerminalOptions } from "@xterm/xterm";

/**
 * The terminal's look: the right sidebar's surface (`dark-850`), the editor's
 * font and text colour, and GitHub Dark's ANSI colours to go with the
 * editor's `github-dark-default` syntax colours.
 */
export const TERMINAL_OPTIONS: ITerminalOptions = {
    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
        background: "#1a1a1a",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        cursorAccent: "#1a1a1a",
        selectionBackground: "rgba(56, 139, 253, 0.35)",
        scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
        scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
        scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.24)",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#ffffff"
    }
};
