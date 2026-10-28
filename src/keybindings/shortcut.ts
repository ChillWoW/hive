import { isMac } from "@/lib/platform";

/**
 * Shortcuts as written in settings.json: modifiers then a key, joined by `+`,
 * e.g. `Mod+Shift+P`. `Mod` is Cmd on macOS and Ctrl elsewhere; `Ctrl` is
 * the Control key, the same as `Mod` off macOS. Parsing is case-insensitive;
 * `canonical` writes the one spelling matching compares.
 */
export type Shortcut = {
    mod: boolean;
    /** Control on macOS; folded into `mod` elsewhere. */
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    key: string;
};

/** `event.code` → key name, for keys whose `event.key` shifts or varies by layout. */
const CODE_KEYS: Record<string, string> = {
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Backquote: "`"
};

/** `event.key` → key name for keys that don't type a character. */
const NAMED_KEYS: Record<string, string> = {
    Enter: "Enter",
    Escape: "Escape",
    Tab: "Tab",
    " ": "Space",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown"
};

const KEY_NAMES = new Map(
    [...Object.values(CODE_KEYS), ...Object.values(NAMED_KEYS)].map((name) => [
        name.toLowerCase(),
        name
    ])
);

const CHARACTER_KEYS = new Set(Object.values(CODE_KEYS));

const isFunctionKey = (key: string) => /^F([1-9]|1\d|2[0-4])$/.test(key);
const isCharacter = (key: string) => /^[A-Z0-9]$/.test(key) || CHARACTER_KEYS.has(key);

function normalizeKey(raw: string): string | null {
    if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
    if (/^f\d{1,2}$/i.test(raw) && isFunctionKey(raw.toUpperCase())) return raw.toUpperCase();
    return KEY_NAMES.get(raw.toLowerCase()) ?? null;
}

export function parseShortcut(text: string): Shortcut | null {
    const parts = text.split("+").map((part) => part.trim());
    const key = normalizeKey(parts.pop() ?? "");
    if (!key) return null;
    const shortcut: Shortcut = { mod: false, ctrl: false, alt: false, shift: false, key };
    for (const part of parts) {
        switch (part.toLowerCase()) {
            case "mod":
            case "cmd":
            case "command":
            case "meta":
                shortcut.mod = true;
                break;
            case "ctrl":
            case "control":
                if (isMac) shortcut.ctrl = true;
                else shortcut.mod = true;
                break;
            case "alt":
            case "option":
                shortcut.alt = true;
                break;
            case "shift":
                shortcut.shift = true;
                break;
            default:
                return null;
        }
    }
    return shortcut;
}

export function stringifyShortcut(s: Shortcut): string {
    return [
        s.mod && "Mod",
        s.ctrl && "Ctrl",
        s.alt && "Alt",
        s.shift && "Shift",
        s.key
    ]
        .filter(Boolean)
        .join("+");
}

/** The comparable spelling of a stored shortcut; null when unbound or unreadable. */
export function canonical(text: string): string | null {
    const shortcut = text.trim() ? parseShortcut(text) : null;
    return shortcut ? stringifyShortcut(shortcut) : null;
}

/** What the event pressed, as a shortcut; null for a lone modifier or an unknown key. */
export function shortcutFromEvent(event: KeyboardEvent): Shortcut | null {
    // The Windows/Super key belongs to the OS.
    if (!isMac && event.metaKey) return null;
    let key: string | null = null;
    if (/^[a-z0-9]$/i.test(event.key)) key = event.key.toUpperCase();
    else if (CODE_KEYS[event.code]) key = CODE_KEYS[event.code]!;
    // Shift or Option changed the character: fall back to the physical key.
    else if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
    else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
    else if (isFunctionKey(event.key)) key = event.key;
    else key = NAMED_KEYS[event.key] ?? null;
    if (!key) return null;
    return {
        mod: isMac ? event.metaKey : event.ctrlKey,
        ctrl: isMac && event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        key
    };
}

export type Assignable = { ok: true } | { ok: false; reason: string };

/** Editing shortcuts every text field relies on. */
const RESERVED = new Set(
    ["Mod+A", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+Y", "Mod+Shift+Z"]
);

/**
 * A shortcut has to leave typing alone: a character needs Mod, Ctrl or Alt;
 * other keys need some modifier, function keys none.
 */
export function checkAssignable(s: Shortcut): Assignable {
    if (RESERVED.has(stringifyShortcut(s))) {
        return { ok: false, reason: "That one is for editing text" };
    }
    if (isFunctionKey(s.key)) return { ok: true };
    const strong = s.mod || s.ctrl || s.alt;
    if (isCharacter(s.key) || s.key === "Space") {
        return strong ? { ok: true } : { ok: false, reason: `Add ${MOD_NAME} or ${ALT_NAME}` };
    }
    return strong || s.shift ? { ok: true } : { ok: false, reason: "Add a modifier key" };
}

const MOD_NAME = isMac ? "⌘" : "Ctrl";
const ALT_NAME = isMac ? "⌥" : "Alt";

const MAC_KEYS: Record<string, string> = {
    Enter: "↩",
    Escape: "Esc",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→"
};

const KEYS: Record<string, string> = {
    Escape: "Esc",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→"
};

/** The keys to draw, one chip each, in the platform's own notation. */
export function shortcutKeys(s: Shortcut): string[] {
    if (isMac) {
        return [
            s.ctrl && "⌃",
            s.alt && "⌥",
            s.shift && "⇧",
            s.mod && "⌘",
            MAC_KEYS[s.key] ?? s.key
        ].filter((k): k is string => !!k);
    }
    return [
        s.mod && "Ctrl",
        s.alt && "Alt",
        s.shift && "Shift",
        KEYS[s.key] ?? s.key
    ].filter((k): k is string => !!k);
}
