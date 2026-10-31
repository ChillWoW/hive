import { useChatsStore, workDir } from "@/chats";
import { useComposerStore } from "@/composer/store";
import {
    blockClose,
    dropDoc,
    openDoc,
    revealLine,
    save,
    useDocsStore,
    type LinePosition
} from "@/editor";
import { fitColumns, useLayoutStore } from "@/stores/useLayoutStore";
import { rememberFile } from "@/palette/store";
import { createSession, disposeSession } from "@/terminal";
import { useRightbarStore } from "./store";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The folder the open chat works in, or the new-chat view's folder. */
export function activeFolder(): string | null {
    const { chats, activeChatId } = useChatsStore.getState();
    const chat = activeChatId ? chats.find((c) => c.id === activeChatId) : undefined;
    return chat ? workDir(chat) : (useComposerStore.getState().newChat.cwd ?? null);
}

/**
 * Opens `path` of `cwd` in a tab (the one it's already in, if any) and shows
 * the right sidebar; with `at`, the
 * cursor goes to that line.
 */
export function openFileTab(cwd: string, path: string, at?: LinePosition) {
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find((t) => t.kind === "file" && t.cwd === cwd && t.path === path);
    let id: string;
    if (open) {
        id = open.id;
        activate(id);
    } else {
        id = add({ kind: "file", cwd, path }, nameOf(path));
        void openDoc(id, cwd, path);
    }
    if (at) revealLine(id, at);
    useLayoutStore.getState().show("right");
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
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find((t) => t.kind === "diff");
    if (open) activate(open.id);
    else add({ kind: "diff" }, "Diff");
    useLayoutStore.getState().show("right");
}

/**
 * Shows the history tab (there's one; it follows the open chat's folder),
 * adding it if it isn't open, and shows the right sidebar.
 */
export function openHistoryTab() {
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find((t) => t.kind === "history");
    if (open) activate(open.id);
    else add({ kind: "history" }, "History");
    useLayoutStore.getState().show("right");
}

/** Opens what commit `sha` of `cwd` changed in a tab (the one it's already in, if any). */
export function openCommitTab(cwd: string, commit: { sha: string; subject: string }) {
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find((t) => t.kind === "commit" && t.cwd === cwd && t.sha === commit.sha);
    if (open) activate(open.id);
    else {
        const subject = commit.subject.trim();
        add(
            { kind: "commit", cwd, sha: commit.sha, subject },
            subject || commit.sha.slice(0, 7)
        );
    }
    useLayoutStore.getState().show("right");
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
