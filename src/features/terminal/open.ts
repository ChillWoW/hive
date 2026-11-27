import { useChatsStore, workDir } from "@/features/chats";
import { panelTabs } from "@/features/panel-tabs/store";
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
