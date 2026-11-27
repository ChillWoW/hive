import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { baseName } from "@/lib/paths";
import { openDoc, revealLine, type LinePosition } from "./documents";

/**
 * Opens `path` (relative to `cwd`) in a file tab, the one it's already in if
 * any, bringing the tabs panel up if it's away; with `at`, the cursor goes
 * to that line. The tab's id.
 */
export function openFileTab(cwd: string, path: string, at?: LinePosition): string {
    const open = usePanelTabsStore
        .getState()
        .tabs.find((t) => t.kind === "file" && t.file?.cwd === cwd && t.file.path === path);
    let id: string;
    if (open) {
        id = open.id;
        panelTabs.select(id);
    } else {
        id = panelTabs.open({ kind: "file", title: baseName(path), detail: path, file: { cwd, path } });
        void openDoc(id, cwd, path);
    }
    if (!getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
    if (at) revealLine(id, at);
    return id;
}
