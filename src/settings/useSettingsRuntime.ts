import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac, isTauri } from "@/lib/platform";
import { hydrateSettings, reloadSettings, useSettingsStore } from "./store";

/**
 * Everything settings do outside the modal: load the document, open the modal
 * on Mod+, and pick up hand edits to settings.json when the window regains
 * focus. Mount once, at the root.
 */
export function useSettingsRuntime() {
    useEffect(() => {
        void hydrateSettings();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const mod = isMac ? event.metaKey : event.ctrlKey;
            if (!mod || event.altKey || event.shiftKey || event.key !== ",")
                return;
            event.preventDefault();
            useSettingsStore.getState().toggle();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

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
