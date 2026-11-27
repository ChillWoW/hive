import { useShortcut } from "@/keybindings";
import { openChangesTab } from "./open";

/** The show-changes shortcut. Mount once, at the root. */
export function useChangesRuntime() {
    useShortcut("showChanges", () => {
        openChangesTab();
    });
}
