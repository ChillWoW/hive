import { useSettingsStore } from "@/features/settings/store";
import { findTheme, useThemesStore } from "./store";

/** Whether the theme in use is a light one. */
export function useLightTheme(): boolean {
    const name = useSettingsStore((s) => s.settings.appearance.theme);
    const user = useThemesStore((s) => s.user);
    return findTheme(name, user).light === true;
}
