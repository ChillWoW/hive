/**
 * A theme is one flat object of 12 colours, each with one job. They become
 * CSS variables on `<html>` (`--bg`, …, `--accent-fg`) and Tailwind classes
 * of the same names (`bg-surface`, `text-muted`, `border-border`, …; see
 * `src/index.css`). Components use only those classes; lighter or darker
 * variants come from opacity (`bg-accent/90`), never new colours.
 */
export interface Theme {
    /** App background, behind everything (darkest). */
    bg: string;
    /** Panels and cards sitting on bg. */
    surface: string;
    /** Things on a surface: inputs, buttons, chips. */
    raised: string;
    /** Hover / highlighted / selected background. */
    hover: string;
    /** Every line and outline. */
    border: string;
    /** Main text. */
    text: string;
    /** Secondary text, icons, placeholders. */
    muted: string;
    /** Brand colour: primary buttons, switches, focus, links. */
    accent: string;
    /** Text and icons drawn on top of accent. */
    accentFg: string;
    /** Green states. */
    success: string;
    /** Red states, destructive actions. */
    danger: string;
    /** Orange/yellow states. */
    warning: string;
    /** True for light themes. */
    light?: boolean;
}

export const COLOR_KEYS = [
    "bg",
    "surface",
    "raised",
    "hover",
    "border",
    "text",
    "muted",
    "accent",
    "accentFg",
    "success",
    "danger",
    "warning"
] as const satisfies readonly (keyof Theme)[];

export const BUILTIN_THEMES: Record<string, Theme> = {
    "Outcode Slate": { bg: "#0b0d11", surface: "#12151a", raised: "#1a1e25", hover: "#222730", border: "#252a33", text: "#e6e8ed", muted: "#8a919f", accent: "#6b8cff", accentFg: "#ffffff", success: "#3fb27f", danger: "#ef5b5b", warning: "#e5a443" },
    Midnight: { bg: "#09070f", surface: "#110e1b", raised: "#1a1628", hover: "#231e35", border: "#2a2440", text: "#ece8f6", muted: "#948ba8", accent: "#a78bfa", accentFg: "#140f22", success: "#4ade9f", danger: "#f87171", warning: "#fbbf24" },
    Ember: { bg: "#0e0907", surface: "#17100d", raised: "#211814", hover: "#2b201a", border: "#33261f", text: "#f3ebe6", muted: "#a1928a", accent: "#ff7a45", accentFg: "#1a0d07", success: "#7fcf74", danger: "#ff5d5d", warning: "#f2b53c" },
    Forest: { bg: "#070c09", surface: "#0e1611", raised: "#152019", hover: "#1c2a21", border: "#223228", text: "#e5efe8", muted: "#86998c", accent: "#4ade80", accentFg: "#06140b", success: "#4ade80", danger: "#f87171", warning: "#facc15" },
    Paper: { bg: "#ecebe7", surface: "#fbfaf8", raised: "#f0eee9", hover: "#e6e3dc", border: "#dcd8cf", text: "#1d1c1a", muted: "#6f6b63", accent: "#2f6fec", accentFg: "#ffffff", success: "#18915a", danger: "#d6453d", warning: "#b7791f", light: true },
    Mono: { bg: "#000000", surface: "#0a0a0a", raised: "#151515", hover: "#1f1f1f", border: "#262626", text: "#f5f5f5", muted: "#8a8a8a", accent: "#f5f5f5", accentFg: "#000000", success: "#a3a3a3", danger: "#f5f5f5", warning: "#d4d4d4" }
};

/** A user theme file's contents as a `Theme`, or why it isn't one. */
export function parseTheme(raw: unknown): Theme | string {
    if (typeof raw !== "object" || raw === null) return "not an object";
    const input = raw as Record<string, unknown>;
    const missing = COLOR_KEYS.filter(
        (key) => typeof input[key] !== "string" || !CSS.supports("color", input[key] as string)
    );
    if (missing.length) return `missing or invalid: ${missing.join(", ")}`;
    const theme = Object.fromEntries(COLOR_KEYS.map((key) => [key, input[key]])) as Omit<Theme, "light">;
    return { ...theme, light: input.light === true };
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/** Read by the inline script in `index.html` to paint the last theme first. */
const CACHE_KEY = "outcode.theme";

/** Sets the theme's variables on `<html>`; nothing else changes. */
export function applyTheme(theme: Theme) {
    const root = document.documentElement;
    const vars = Object.fromEntries(COLOR_KEYS.map((key) => ["--" + kebab(key), theme[key]]));
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.light ? "light" : "dark";
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ vars, light: !!theme.light }));
    } catch {
        // Storage blocked: the next launch paints the default first.
    }
}
