import {
    blockClose,
    dropDoc,
    openDoc,
    revealLine,
    save,
    useDocsStore,
    type LinePosition
} from "@/editor";
import { baseName } from "@/lib/paths";
import { fitColumns, useLayoutStore } from "@/stores/useLayoutStore";
import { rememberFile } from "@/palette/store";
import { createSession, disposeSession } from "@/terminal";
import { activeFolder } from "./folders";
import { useRightbarStore, type RightTab, type TabContent } from "./store";

/**
 * Shows the first tab `matches` picks, else adds one with `content` (`added`
 * runs on its id), and shows the right sidebar; the tab's id.
 */
function showTab(
    matches: (tab: RightTab) => boolean,
    content: TabContent,
    title: string,
    added?: (id: string) => void
): string {
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find(matches);
    let id: string;
    if (open) {
        id = open.id;
        activate(id);
    } else {
        id = add(content, title);
        added?.(id);
    }
    useLayoutStore.getState().show("right");
    return id;
}

/**
 * Opens `path` of `cwd` in a tab (the one it's already in, if any) and shows
 * the right sidebar; with `at`, the cursor goes to that line.
 */
export function openFileTab(cwd: string, path: string, at?: LinePosition) {
    const id = showTab(
        (t) => t.kind === "file" && t.cwd === cwd && t.path === path,
        { kind: "file", cwd, path },
        baseName(path),
        (id) => void openDoc(id, cwd, path)
    );
    if (at) revealLine(id, at);
    rememberFile(cwd, path);
}

/**
 * Opens a new terminal tab with the user's shell in `cwd` (the open chat's
 * folder by default) and shows the right sidebar. Typing `exit` closes it.
 */
export function openTerminalTab(cwd: string | null = activeFolder()) {
    const { add, retitle } = useRightbarStore.getState();
    const id = add({ kind: "terminal", cwd }, "Terminal");
    createSession(id, cwd, {
        onTitle: (title) => retitle(id, title),
        onClosed: () => discardTab(id)
    });
    useLayoutStore.getState().show("right");
}

/**
 * Shows the diff tab (there's one; it follows the open chat's folder),
 * adding it if it isn't open, and shows the right sidebar.
 */
export function openDiffTab() {
    showTab((t) => t.kind === "diff", { kind: "diff" }, "Diff");
}

/**
 * Shows the history tab (there's one; it follows the open chat's folder),
 * adding it if it isn't open, and shows the right sidebar.
 */
export function openHistoryTab() {
    showTab((t) => t.kind === "history", { kind: "history" }, "History");
}

/** Opens what commit `sha` of `cwd` changed in a tab (the one it's already in, if any). */
export function openCommitTab(cwd: string, commit: { sha: string; subject: string }) {
    const { sha } = commit;
    const subject = commit.subject.trim();
    showTab(
        (t) => t.kind === "commit" && t.cwd === cwd && t.sha === sha,
        { kind: "commit", cwd, sha, subject },
        subject || sha.slice(0, 7)
    );
}

/** Closes a tab, saving its file first; a failed save keeps it open and says so. */
export async function closeTab(id: string) {
    const doc = useDocsStore.getState().docs[id];
    if (doc?.dirty && !(await save(id))) {
        blockClose(id);
        useRightbarStore.getState().activate(id);
        return;
    }
    discardTab(id);
}

/** Closes the right sidebar's shown tab; false while the sidebar is hidden or empty. */
export function closeShownTab(): boolean {
    const layout = useLayoutStore.getState();
    if (!fitColumns(window.innerWidth, layout).right) return false;
    const { activeId } = useRightbarStore.getState();
    if (!activeId) return false;
    void closeTab(activeId);
    return true;
}

/** Closes a tab, unsaved changes (or a running shell) and all. */
export function discardTab(id: string) {
    useRightbarStore.getState().remove(id);
    dropDoc(id);
    disposeSession(id);
}
