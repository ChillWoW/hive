import { useShortcut } from "@/keybindings";
import { files } from "./store";

/** The search-in-files shortcut. Mount once, at the root. */
export function useFilesRuntime() {
    useShortcut("searchInFiles", files.searchText);
}
