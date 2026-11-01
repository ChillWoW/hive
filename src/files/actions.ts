import { useChatsStore } from "@/chats";
import { composer } from "@/composer/store";
import { checkAllOnDisk, moveDoc } from "@/editor";
import { useRightbarStore } from "@/rightbar/store";
import { copyText } from "@/lib/clipboard";
import { baseName } from "@/lib/paths";
import { containsPath, deleteEntry, renameEntry } from "./api";
import { fileMention } from "./mentions";
import { useFilesPanelStore } from "./panel";
import { refreshFiles } from "./store";
import { reloadTree } from "./tree";

/**
 * `relative` under `root` as a full path in the root's own form: a Windows
 * root gets `\`s.
 */
function absolutePath(root: string, relative: string): string {
    const windows = root.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(root);
    if (windows) {
        return `${root.replace(/[\\/]+$/, "").replaceAll("/", "\\")}\\${relative.replaceAll("/", "\\")}`;
    }
    return `${root.replace(/\/+$/, "")}/${relative}`;
}

/** Copies `path`'s full path to the clipboard. */
export function copyEntryPath(cwd: string, path: string) {
    void copyText(absolutePath(cwd, path));
}

/**
 * Mentions `path` (`@path`, a folder as `@dir/`) at the end of the open
 * chat's draft, or the new chat's, and puts the caret there.
 */
export function addEntryToChat(path: string, dir: boolean) {
    const chatId = useChatsStore.getState().activeChatId;
    const draft = composer.draft(chatId);
    const mention = fileMention(dir ? `${path}/` : path);
    const gap = draft && !/\s$/.test(draft) ? " " : "";
    composer.setDraft(chatId, `${draft}${gap}${mention} `);
    composer.focus();
}

/** The tree and the search listing re-read, with and without ignored files. */
function relist(cwd: string) {
    for (const all of [false, true]) {
        reloadTree(cwd, all);
        void refreshFiles(cwd, all, true);
    }
}

/**
 * The expanded folders and the selection at or under `path` follow `to`:
 * their new path, or null for gone.
 */
function followPanel(cwd: string, path: string, to: (p: string) => string | null) {
    const map = (p: string) => (containsPath(path, p) ? to(p) : p);
    useFilesPanelStore.setState((s) => ({
        expanded: { ...s.expanded, [cwd]: (s.expanded[cwd] ?? []).flatMap((p) => map(p) ?? []) },
        selected: s.selected && map(s.selected)
    }));
}

/**
 * Renames `path` of `cwd` to `name`: expanded folders,
 * the selection and open file tabs under it follow; the new path.
 */
export async function renameTreeEntry(cwd: string, path: string, name: string) {
    const to = await renameEntry(cwd, path, name);
    const moved = (p: string) => to + p.slice(path.length);
    followPanel(cwd, path, moved);
    const { tabs, repath } = useRightbarStore.getState();
    for (const tab of tabs) {
        if (tab.kind !== "file" || tab.cwd !== cwd || !containsPath(path, tab.path)) continue;
        const next = moved(tab.path);
        repath(tab.id, next, baseName(next));
        moveDoc(tab.id, next);
    }
    relist(cwd);
    return to;
}

/**
 * Deletes `path` of `cwd` for good. Open tabs of what went keep their text,
 * marked deleted on disk, so nothing unsaved is lost.
 */
export async function deleteTreeEntry(cwd: string, path: string) {
    await deleteEntry(cwd, path);
    followPanel(cwd, path, () => null);
    relist(cwd);
    checkAllOnDisk(cwd);
}
