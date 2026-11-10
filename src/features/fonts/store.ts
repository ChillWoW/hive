import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { backend } from "@/lib/backend";

/** Bundled (`@fontsource-variable/geist`), so it's there on every system. */
export const DEFAULT_FONT = DEFAULT_SETTINGS.appearance.fontFamily;

/** Setting names whose CSS family differs: the bundled ones. */
const BUNDLED: Record<string, string> = {
    [DEFAULT_FONT]: "Geist Variable"
};

/** A setting's family as a quoted CSS `font-family` value. */
export function cssFontFamily(name: string): string {
    const family = BUNDLED[name] ?? name;
    return `"${family.replace(/["\\]/g, "\\$&")}"`;
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

/** The bundled font first, then installed ones, plus `current` if it's gone. */
export function fontChoices(installed: string[], current: string): string[] {
    const rest = installed.filter((name) => name.toLowerCase() !== DEFAULT_FONT.toLowerCase());
    if (current !== DEFAULT_FONT && !rest.includes(current)) {
        rest.push(current);
        rest.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }
    return [DEFAULT_FONT, ...rest];
}
