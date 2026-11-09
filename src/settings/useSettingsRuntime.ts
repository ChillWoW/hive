import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/lib/platform";
import { hydrateSettings, reloadSettings } from "./store";

/**
 * Loads the document and picks up hand edits to settings.json when the
 * window regains focus. Mount once, at the root.
 */
export function useSettingsRuntime() {
    useEffect(() => {
        void hydrateSettings();
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
