/**
 * A theme is one flat object of 12 colours (plus an optional `info`), each
 * with one job. They become CSS variables on `<html>` (`--bg`, …,
 * `--accent-fg`) and Tailwind classes
 * of the same names (`bg-surface`, `text-muted`, `border-border`, …; see
 * `src/index.css`). Components use only those classes; lighter or darker
 * variants come from opacity (`bg-accent/90`), never new colours.
 */
export interface Theme {
    /** The main working area, inset in the frame (darkest on dark themes, white on light). */
    bg: string;
    /** The frame around bg, and panels and cards sitting on bg. */
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
    "Outcode Chalk": { bg: "#ffffff", surface: "#f5f5f6", raised: "#efeff1", hover: "#e8e8eb", border: "#e1e1e5", text: "#1b1b1f", muted: "#6b6b73", accent: "#1b1b1f", accentFg: "#ffffff", success: "#1a7f45", danger: "#d4343f", warning: "#b4610b", light: true },
    Midnight: { bg: "#0e1116", surface: "#13171d", raised: "#191e26", hover: "#20262f", border: "#29303b", text: "#e8ecf2", muted: "#8791a1", accent: "#6aa5ff", accentFg: "#07111f", success: "#6fd598", danger: "#ff6b78", warning: "#f3b75a", info: "#5ccbe6" },
    Evergreen: { bg: "#0f1312", surface: "#141918", raised: "#1a201e", hover: "#212826", border: "#2a3230", text: "#e7edea", muted: "#87938f", accent: "#4fd6a2", accentFg: "#04170f", success: "#a3d968", danger: "#ff6f6f", warning: "#f2bc5c", info: "#62b8f0" },
    Orchid: { bg: "#121117", surface: "#17161d", raised: "#1d1c25", hover: "#25232e", border: "#2f2d3a", text: "#eceaf4", muted: "#918ea3", accent: "#a98eff", accentFg: "#120a29", success: "#7fd8a0", danger: "#ff6f81", warning: "#f3b961", info: "#6fb7f5" },
    Ember: { bg: "#151312", surface: "#1a1817", raised: "#211e1c", hover: "#292523", border: "#332e2b", text: "#f0ebe7", muted: "#998f88", accent: "#ff9158", accentFg: "#1d0d03", success: "#8fce7e", danger: "#ff6565", warning: "#f2c14e", info: "#7ab8e8" },
    Void: { bg: "#000000", surface: "#0c0c0c", raised: "#161616", hover: "#202020", border: "#2a2a2a", text: "#f2f2f2", muted: "#8c8c8c", accent: "#ffffff", accentFg: "#000000", success: "#5fd38a", danger: "#ff5c5c", warning: "#f2b84b" },
    Paper: { bg: "#fdfcfa", surface: "#f4f2ed", raised: "#ece9e2", hover: "#e4e0d7", border: "#dad5ca", text: "#25221d", muted: "#6f695f", accent: "#bf4f17", accentFg: "#ffffff", success: "#2c7a3a", danger: "#c8362e", warning: "#a15c08", info: "#2a6fc9", light: true }
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

/** `shadow-shadow/40`: black on dark themes, a fainter ink on light ones. */
const SHADOW = "#000";
const SHADOW_LIGHT = "rgb(24 24 27 / 0.4)";

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
    vars["--shadow"] = theme.light ? SHADOW_LIGHT : SHADOW;
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    root.style.colorScheme = theme.light ? "light" : "dark";
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ vars, light: !!theme.light }));
    } catch {
        // Storage blocked: the next launch paints the default first.
    }
}
