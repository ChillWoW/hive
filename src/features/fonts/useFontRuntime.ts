import { useEffect } from "react";
import { useSettingsStore } from "@/features/settings/store";
import { cssFontFamily } from "./store";

/** Applies the interface font setting. Mount once, at the root. */
export function useFontRuntime() {
    const name = useSettingsStore((s) => s.settings.appearance.fontFamily);

    useEffect(() => {
        document.documentElement.style.setProperty("--font-ui", cssFontFamily(name));
    }, [name]);
}
