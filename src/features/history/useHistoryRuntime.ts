import { useShortcut } from "@/keybindings";
import { openHistoryTab } from "./open";

/** The show-history shortcut. Mount once, at the root. */
export function useHistoryRuntime() {
    useShortcut("showHistory", () => {
        openHistoryTab();
    });
}
