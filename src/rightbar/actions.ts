import { useChatsStore, workDir } from "@/chats";
import { useComposerStore } from "@/composer/store";
import { blockClose, dropDoc, openDoc, save, useDocsStore } from "@/editor";
import { useLayoutStore } from "@/stores/useLayoutStore";
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
 * the right sidebar, as zeron opens a file from its tree.
 */
export function openFileTab(cwd: string, path: string) {
    const { tabs, activate, add } = useRightbarStore.getState();
    const open = tabs.find((t) => t.kind === "file" && t.cwd === cwd && t.path === path);
    if (open) activate(open.id);
    else void openDoc(add({ kind: "file", cwd, path }, nameOf(path)), cwd, path);
    useLayoutStore.getState().show("right");
}

/**
 * Opens a new terminal tab with the user's shell in `cwd` (the open chat's
 * folder by default) and shows the right sidebar. Typing `exit` closes it.
 */
export function openTerminalTab(cwd: string | null = activeFolder()) {
    const { add, retitle } = useRightbarStore.getState();
    const id = add({ kind: "terminal", cwd }, "Terminal");
    createSession(id, cwd, {
        onStarted: (shell) => retitle(id, shell),
        onClosed: () => discardTab(id)
    });
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

/** Closes a tab, unsaved changes (or a running shell) and all. */
export function discardTab(id: string) {
    useRightbarStore.getState().remove(id);
    dropDoc(id);
    disposeSession(id);
}
