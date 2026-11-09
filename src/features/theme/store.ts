import { create } from "zustand";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { backend } from "@/lib/backend";
import { BUILTIN_THEMES, parseTheme, type Theme } from "./themes";

type UserThemeFile = { name: string; colors: unknown };

type ThemesState = {
    /** From `<data dir>/themes/*.json`; a name shared with a built-in wins. */
    user: Record<string, Theme>;
    load: () => Promise<void>;
};

export const useThemesStore = create<ThemesState>()((set) => ({
    user: {},
    load: async () => {
        // Rejects under `bun run dev` (no backend): no user themes there.
        const files = await backend<UserThemeFile[]>("themes_list").catch(() => []);
        const user: Record<string, Theme> = {};
        for (const file of files) {
            const theme = parseTheme(file.colors);
            if (typeof theme === "string") console.warn(`[themes] ${file.name}: ${theme}`);
            else user[file.name] = theme;
        }
        set({ user });
    }
}));

export function allThemes(user: Record<string, Theme>): Record<string, Theme> {
    return { ...BUILTIN_THEMES, ...user };
}

/** The named theme, or the default when it's gone. */
export function findTheme(name: string, user: Record<string, Theme>): Theme {
    return user[name] ?? BUILTIN_THEMES[name] ?? BUILTIN_THEMES[DEFAULT_SETTINGS.appearance.theme];
}

export const themesApi = {
    openDir: (): Promise<void> => backend("themes_open_dir")
};
