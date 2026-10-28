import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShortcut } from "@/keybindings/runtime";
import { isTauri } from "@/lib/platform";
import { hydrateSettings, reloadSettings, useSettingsStore } from "./store";

/**
 * Everything settings do outside the modal: load the document, toggle the
 * modal on its shortcut (Mod+, by default), and pick up hand edits to settings.json when the window regains
 * focus. Mount once, at the root.
 */
export function useSettingsRuntime() {
    useEffect(() => {
        void hydrateSettings();
    }, []);

    useShortcut("openSettings", () => useSettingsStore.getState().toggle());

    useEffect(() => {
        if (!isTauri) return;
        const unlisten = getCurrentWindow().onFocusChanged(({ payload }) => {
            if (payload) reloadSettings();
        });
        return () => {
            void unlisten.then((stop) => stop());
        };
    }, []);
}
