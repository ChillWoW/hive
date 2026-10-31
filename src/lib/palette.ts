/**
 * The `dark-*` scale as hex, for the places that can't read CSS variables
 * (CodeMirror, xterm, Mermaid, the history graph's colour maths). A slate
 * ramp: OKLCH hue 265, chroma ≤ 0.0055, even lightness steps. Keep in sync
 * with `--color-dark-*` in `src/index.css`.
 */
export const DARK = {
    50: "#e4e4e6",
    100: "#c3c4c6",
    200: "#8e8f92",
    250: "#7c7d80",
    300: "#6a6c6f",
    400: "#4c4d50",
    500: "#3a3c3f",
    600: "#2d2e30",
    700: "#242527",
    800: "#1e1f20",
    850: "#19191b",
    900: "#141517",
    950: "#0e0e10"
} as const;
