import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/features/settings/store";
import { isTauri } from "@/lib/platform";
import { findTheme, useThemesStore } from "./store";
import { applyTheme } from "./themes";

/**
 * Applies the theme setting, and re-reads the themes folder when the window
 * regains focus so a theme file edited outside shows up. Mount once, at the
 * root.
 */
export function useThemeRuntime() {
    const name = useSettingsStore((s) => s.settings.appearance.theme);
    const user = useThemesStore((s) => s.user);

    useEffect(() => {
        applyTheme(findTheme(name, user));
    }, [name, user]);

    useEffect(() => {
        const { load } = useThemesStore.getState();
        void load();
        if (!isTauri) return;
        const unlisten = getCurrentWindow().onFocusChanged(({ payload }) => {
            if (payload) void load();
        });
        return () => {
            void unlisten.then((stop) => stop());
        };
    }, []);
}
