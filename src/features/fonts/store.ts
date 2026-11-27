import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { backend } from "@/lib/backend";

/** Bundled (`@fontsource-variable/geist`), so it's there on every system. */
export const DEFAULT_FONT = DEFAULT_SETTINGS.appearance.fontFamily;

/** The platform's UI font (SF Pro on macOS, Segoe UI on Windows), which font listings hide. */
export const SYSTEM_FONT = "System";

/** Setting names that aren't an installed family, as CSS `font-family` values. */
const BUILTIN: Record<string, string> = {
    [DEFAULT_FONT]: '"Geist Variable"',
    [SYSTEM_FONT]: "system-ui, -apple-system, BlinkMacSystemFont"
};

/** A setting's family as a CSS `font-family` value. */
export function cssFontFamily(name: string): string {
    return BUILTIN[name] ?? `"${name.replace(/["\\]/g, "\\$&")}"`;
}

type FontsState = {
    /** Installed families; `null` until first loaded. */
    installed: string[] | null;
    load: () => Promise<void>;
};

export const useFontsStore = create<FontsState>()((set, get) => ({
    installed: null,
    load: async () => {
        if (get().installed) return;
        // Rejects under `bun run dev` (no backend): only the bundled font there.
        const installed = await backend<string[]>("fonts_list").catch(() => []);
        set({ installed });
    }
}));

/** `leading` (by default the bundled and system fonts), then installed ones, plus `current` if it's gone. */
export function fontChoices(
    installed: string[],
    current: string,
    leading: string[] = [DEFAULT_FONT, SYSTEM_FONT]
): string[] {
    const taken = new Set(leading.map((name) => name.toLowerCase()));
    const rest = installed.filter((name) => !taken.has(name.toLowerCase()));
    if (!leading.includes(current) && !rest.includes(current)) {
        rest.push(current);
        rest.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }
    return [...leading, ...rest];
}
