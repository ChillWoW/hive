import { useShortcut } from "@/keybindings";
import { useUsageStore } from "./store";

/** Mounted in `App`: the shortcut. */
export function useUsageRuntime() {
    useShortcut("openUsage", () => useUsageStore.getState().toggle());
}
