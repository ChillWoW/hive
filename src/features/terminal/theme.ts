import type { ITheme } from "@xterm/xterm";
import type { Theme } from "@/features/theme/themes";

/** ANSI colours: GitHub's dark and light terminal palettes, readable on any of the app's themes. */
const DARK_ANSI = {
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
} satisfies ITheme;

const LIGHT_ANSI = {
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f"
} satisfies ITheme;

let canvas: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour (a user theme can use any) as `[r, g, b]`; black if unreadable. */
function rgbOf(color: string): [number, number, number] {
    canvas ??= document.createElement("canvas").getContext("2d");
    if (!canvas) return [0, 0, 0];
    canvas.fillStyle = "#000";
    canvas.fillStyle = color;
    // Normalized to `#rrggbb`, or `rgba(r, g, b, a)` when translucent.
    const value = String(canvas.fillStyle);
    if (value.startsWith("#")) {
        const n = Number.parseInt(value.slice(1, 7), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const [r = 0, g = 0, b = 0] = value.match(/[\d.]+/g)?.map(Number) ?? [];
    return [r, g, b];
}

/** `color` at `alpha`, in a form xterm parses. */
function withAlpha(color: string, alpha: number): string {
    const [r, g, b] = rgbOf(color);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** As `#rrggbb`, which xterm needs for the colours it blends. */
function opaque(color: string): string {
    return `#${rgbOf(color)
        .map((c) => Math.round(c).toString(16).padStart(2, "0"))
        .join("")}`;
}

/** The terminal in the app's theme: its background, text and accent, with ANSI colours for light or dark. */
export function terminalTheme(theme: Theme): ITheme {
    const light = theme.light === true;
    const bg = opaque(theme.bg);
    const text = opaque(theme.text);
    return {
        background: bg,
        foreground: text,
        cursor: text,
        cursorAccent: bg,
        selectionBackground: withAlpha(theme.accent, light ? 0.2 : 0.28),
        selectionInactiveBackground: withAlpha(theme.muted, 0.2),
        scrollbarSliderBackground: withAlpha(theme.text, 0.1),
        scrollbarSliderHoverBackground: withAlpha(theme.text, 0.18),
        scrollbarSliderActiveBackground: withAlpha(theme.text, 0.24),
        ...(light ? LIGHT_ANSI : DARK_ANSI)
    };
}
