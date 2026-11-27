import type { BackgroundTask } from "@/proto";
import { useChatsStore, workDir } from "@/features/chats";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { settings } from "@/features/settings/store";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { getHomeDir, tildify } from "@/lib/home";
import { createSession } from "./sessions";

let home: string | null = null;
void getHomeDir().then((dir) => (home = dir));

/** Where `terminal.startIn` says a new terminal starts: the open chat's folder (or the new-chat view's pick), or home. */
function startDir(): string | null {
    if (settings.get().terminal.startIn === "home") return null;
    const { chats, activeChatId, newChatCwd } = useChatsStore.getState();
    const chat = chats.find((c) => c.id === activeChatId);
    return (chat ? workDir(chat) : newChatCwd) || null;
}

/** Opens a terminal tab beside the shown one, bringing the tabs panel up if it's away. */
export function openTerminal(cwd: string | null = startDir()) {
    const id = panelTabs.open({
        kind: "terminal",
        title: "Terminal",
        detail: cwd ? tildify(cwd, home) : "~"
    });
    createSession(id, cwd, {
        onTitle: (title) => panelTabs.update(id, { title }),
        onClose: () => panelTabs.close(id)
    });
    if (!getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
    return id;
}

/**
 * Shows chat `chatId`'s background shell `task` in an output tab (the one it
 * has, else a new one), bringing the tabs panel up if it's away. `command`
 * is what it runs.
 */
export function openTaskOutput(chatId: string, task: BackgroundTask, command?: string) {
    if (!task.outputFile) return;
    const open = usePanelTabsStore
        .getState()
        .tabs.find((t) => t.output?.chatId === chatId && t.output.taskId === task.id);
    if (open) panelTabs.select(open.id);
    else {
        panelTabs.open({
            kind: "output",
            title: task.description || command || "Shell",
            detail: command,
            output: { chatId, taskId: task.id, path: task.outputFile, command }
        });
    }
    if (!getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
}
