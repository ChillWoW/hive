import { useEffect } from "react";
import { useSettingsStore } from "@/features/settings/store";
import { cssFontFamily } from "./store";

/** Applies the interface and code font settings. Mount once, at the root. */
export function useFontRuntime() {
    const name = useSettingsStore((s) => s.settings.appearance.fontFamily);
    const code = useSettingsStore((s) => s.settings.appearance.codeFontFamily);

    useEffect(() => {
        document.documentElement.style.setProperty("--font-ui", cssFontFamily(name));
    }, [name]);

    useEffect(() => {
        // Unset, `--font-mono` falls through to the system monospace font.
        const style = document.documentElement.style;
        if (code) style.setProperty("--font-code", cssFontFamily(code));
        else style.removeProperty("--font-code");
    }, [code]);
}
