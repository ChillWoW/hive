import { useChatsStore, workDir } from "@/chats";
import { useComposerStore } from "@/composer/store";
import { platform } from "@/lib/platform";
import { openFileTab } from "./actions";

/** The folder the open chat works in, or the new-chat view's; null for neither. */
export function useActiveFolder() {
    const chatDir = useChatsStore((s) => {
        const chat = s.activeChatId ? s.chats.find((c) => c.id === s.activeChatId) : undefined;
        return chat ? workDir(chat) : undefined;
    });
    const newChatDir = useComposerStore((s) => s.newChat.cwd ?? null);
    return chatDir ?? newChatDir;
}

const norm = (path: string) => {
    const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "windows" ? p.toLowerCase() : p;
};

/**
 * Opens `path` of a patch read in `folder`, whose paths are relative to the
 * checkout `root`: in `folder` when it's inside it (the chat may work in a
 * subfolder), else in the root.
 */
export function openPatchFile(folder: string, root: string, path: string) {
    const r = norm(root);
    const f = norm(folder);
    if (f === r) return openFileTab(folder, path);
    if (f.startsWith(`${r}/`)) {
        const sub = folder.replace(/\\/g, "/").slice(root.length + 1).replace(/\/+$/, "");
        if (path.startsWith(`${sub}/`)) return openFileTab(folder, path.slice(sub.length + 1));
    }
    openFileTab(root, path);
}
