/**
 * A theme is one flat object of 12 colours (plus an optional `info`), each
 * with one job. They become CSS variables on `<html>` (`--bg`, …,
 * `--accent-fg`) and Tailwind classes
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
    /** Links and live, informational states (blue). Optional: defaults by `light`. */
    info?: string;
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
    "Outcode Slate": { bg: "#131315", surface: "#18181a", raised: "#1e1e21", hover: "#252528", border: "#2e2e32", text: "#ededee", muted: "#8e8e94", accent: "#e6eeee", accentFg: "#131315", success: "#8fd68b", danger: "#ff6b6b", warning: "#f5b85c" },
    "Outcode Chalk": { bg: "#ebebee", surface: "#ffffff", raised: "#f4f4f6", hover: "#e0e0e5", border: "#d6d6dc", text: "#18181b", muted: "#62626b", accent: "#27272a", accentFg: "#fafafa", success: "#1f8a4c", danger: "#cf3443", warning: "#a96410", light: true },
    Fjord: { bg: "#0f1217", surface: "#14181f", raised: "#1a1f28", hover: "#212732", border: "#272e3a", text: "#dfe4ec", muted: "#8691a2", accent: "#86a8e0", accentFg: "#0f1217", success: "#93cf9e", danger: "#ec7b86", warning: "#e5b97c" },
    Moss: { bg: "#111310", surface: "#161914", raised: "#1c2019", hover: "#232820", border: "#2a3026", text: "#e2e6da", muted: "#8e9585", accent: "#b4c97c", accentFg: "#121509", success: "#9ccf72", danger: "#e5786d", warning: "#e3b462" },
    Dusk: { bg: "#140f1a", surface: "#1b1522", raised: "#231c2c", hover: "#2c2337", border: "#342a40", text: "#eee6f4", muted: "#a093b0", accent: "#f0a3c8", accentFg: "#1e0f1a", success: "#a2d49c", danger: "#f07a7a", warning: "#f0b87a" },
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
    const info = typeof input.info === "string" && CSS.supports("color", input.info) ? input.info : undefined;
    return { ...theme, info, light: input.light === true };
}

const DEFAULT_INFO = "#6fb3f2";
const DEFAULT_INFO_LIGHT = "#2563eb";

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/** Read by the inline script in `index.html` to paint the last theme first. */
const CACHE_KEY = "outcode.theme";

/** Sets the theme's variables on `<html>`; nothing else changes. */
export function applyTheme(theme: Theme) {
    const root = document.documentElement;
    const vars: Record<string, string> = Object.fromEntries(
        COLOR_KEYS.map((key) => ["--" + kebab(key), theme[key]])
    );
    vars["--info"] = theme.info ?? (theme.light ? DEFAULT_INFO_LIGHT : DEFAULT_INFO);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.light ? "light" : "dark";
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ vars, light: !!theme.light }));
    } catch {
        // Storage blocked: the next launch paints the default first.
    }
}
