import { useChatsStore, workDir } from "@/features/chats/store";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { getHomeDir, tildify } from "@/lib/home";

let home: string | null = null;
void getHomeDir().then((dir) => (home = dir));

/** The open chat's folder, or the new-chat view's pick; null when there's neither. */
export function currentFolder(): string | null {
    const { chats, activeChatId, newChatCwd } = useChatsStore.getState();
    const chat = chats.find((c) => c.id === activeChatId);
    return (chat ? workDir(chat) : newChatCwd) || null;
}

/** `currentFolder()`, for render. */
export function useCurrentFolder(): string | null {
    return useChatsStore((s) => {
        const chat = s.chats.find((c) => c.id === s.activeChatId);
        return (chat ? workDir(chat) : s.newChatCwd) || null;
    });
}

/**
 * Shows `cwd`'s uncommitted changes in a diff tab, the one already showing
 * them if any, bringing the tabs panel up if it's away. The tab's id; null
 * when there's no folder to show.
 */
export function openChangesTab(cwd: string | null = currentFolder()): string | null {
    if (!cwd) return null;
    const open = usePanelTabsStore
        .getState()
        .tabs.find((t) => t.kind === "diff" && t.diff?.cwd === cwd && !t.diff.chatId);
    let id: string;
    if (open) {
        id = open.id;
        panelTabs.select(id);
    } else {
        id = panelTabs.open({ kind: "diff", title: "Changes", detail: tildify(cwd, home), diff: { cwd } });
    }
    if (!getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
    return id;
}

/**
 * Shows what chat `chatId`'s latest turn changed in `cwd`'s checkout in a
 * diff tab of its own, the one already showing it if any.
 */
export function openTurnChangesTab(chatId: string, cwd: string): string {
    const open = usePanelTabsStore.getState().tabs.find((t) => t.kind === "diff" && t.diff?.chatId === chatId);
    let id: string;
    if (open) {
        id = open.id;
        // A handed-off chat may have moved folders since.
        if (open.diff?.cwd !== cwd) panelTabs.update(id, { detail: tildify(cwd, home), diff: { cwd, chatId } });
        panelTabs.select(id);
    } else {
        id = panelTabs.open({ kind: "diff", title: "Last turn", detail: tildify(cwd, home), diff: { cwd, chatId } });
    }
    if (!getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
    return id;
}
