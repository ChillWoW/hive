import type { WorkspaceEntry } from "@/proto";
import { useChatsStore } from "@/features/chats";
import { fileMention } from "@/features/composer/files";
import { composer } from "@/features/composer/store";
import { moveDocs } from "@/features/editor/documents";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { backend } from "@/lib/backend";
import { copyText } from "@/lib/clipboard";
import { errorMessage } from "@/lib/errors";
import { toast } from "@/ui";
import { refreshFiles } from "./listing";
import { files, useFilesStore } from "./store";
import { isUnder, movedPath, nameOf, parentOf } from "./tree";

/** Lists `root` again after a change to it: what the panel shows, and the composer's `@` menu. */
function relist(root: string): Promise<unknown> {
    const { showIgnored } = useFilesStore.getState();
    const plain = refreshFiles(root, { force: true });
    return showIgnored ? Promise.all([plain, refreshFiles(root, { force: true, ignored: true })]) : plain;
}

/** `root`'s open file tabs at or under `path`. */
const tabsUnder = (root: string, path: string) =>
    usePanelTabsStore
        .getState()
        .tabs.filter((t) => t.kind === "file" && t.file?.cwd === root && isUnder(t.file.path, path));

/** `path` under `root` in full, with the separators `root` uses. */
function absolutePath(root: string, path: string): string {
    const separator = root.includes("\\") ? "\\" : "/";
    return root.replace(/[/\\]+$/, "") + separator + path.split("/").join(separator);
}

/** Puts `entry` at the end of the shown chat's unsent prompt, as an `@` mention. */
export function addToChat(entry: WorkspaceEntry) {
    const chatId = useChatsStore.getState().activeChatId;
    const draft = composer.draft(chatId);
    const gap = draft && !/\s$/.test(draft) ? " " : "";
    composer.setDraft(chatId, `${draft}${gap}${fileMention(entry.dir ? `${entry.path}/` : entry.path)} `);
    composer.focus();
}

/** Copies `path` to the clipboard: in full, or (`relative`) as it is under `root`. */
export function copyPath(root: string, path: string, relative = false) {
    void copyText(relative ? path : absolutePath(root, path));
}

/**
 * Renames `entry` to `name`, in its folder; its open tabs, open folders and
 * the pick follow. The new path, or null when it failed (a toast says why).
 */
export async function renameEntry(root: string, entry: WorkspaceEntry, name: string): Promise<string | null> {
    const from = entry.path;
    const failed = (description: string) => {
        toast.error({ title: `Couldn't rename ${nameOf(from)}`, description });
        return null;
    };
    if (/[/\\]/.test(name)) return failed("A name can't have a slash in it.");
    const parent = parentOf(from);
    const to = parent ? `${parent}/${name}` : name;
    try {
        await backend<void>("rename_path", { cwd: root, from, to }, () => undefined);
    } catch (error) {
        return failed(errorMessage(error));
    }
    for (const tab of tabsUnder(root, from)) {
        const path = movedPath(tab.file!.path, from, to);
        panelTabs.update(tab.id, { title: nameOf(path), detail: path, file: { cwd: root, path } });
    }
    moveDocs(root, from, to);
    files.moved(root, from, to);
    await relist(root);
    return to;
}

/** Moves `entry` to the system's trash; its open tabs close, unsaved changes and all. */
export async function trashEntry(root: string, entry: WorkspaceEntry) {
    await backend<void>("trash_path", { cwd: root, path: entry.path }, () => undefined);
    for (const tab of tabsUnder(root, entry.path)) panelTabs.close(tab.id, true);
    files.removed(root, entry.path);
    await relist(root);
}
