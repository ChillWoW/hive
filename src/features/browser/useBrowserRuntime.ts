import { useEffect } from "react";
import { useChatsStore } from "@/features/chats";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { useShortcut } from "@/keybindings";
import { getPanelLayout, useLayoutStore } from "@/layout/store";
import { browserApi, type BrowserTab } from "./api";
import { openBrowser } from "./open";
import { tabTitle, useBrowserStore } from "./store";

const put = (tab: BrowserTab) => useBrowserStore.setState((s) => ({ tabs: { ...s.tabs, [tab.id]: tab } }));

const drop = (id: string) =>
    useBrowserStore.setState((s) => {
        const { [id]: _, ...tabs } = s.tabs;
        return { tabs, picking: s.picking === id ? null : s.picking };
    });

/**
 * Browser tabs: the new-tab shortcut, and the panel tabs kept in step with
 * the backend's, which owns them. One opened there (by the user here, by an
 * agent, by a page opening a window) gets a panel tab; a panel tab closed
 * here closes its browser tab. An agent's tab comes to the front only when
 * its chat is the one shown. Mount once, at the root.
 */
export function useBrowserRuntime() {
    useShortcut("newBrowserTab", () => openBrowser());

    useEffect(() => {
        /** Gives a browser tab its panel tab; at the `front`, it's shown and the panel brought up. */
        const adopt = (tab: BrowserTab, front: boolean) => {
            put(tab);
            if (usePanelTabsStore.getState().tabs.some((t) => t.id === tab.id)) return;
            panelTabs.open({ kind: "browser", title: tabTitle(tab), detail: tab.url }, { id: tab.id, background: !front });
            if (front && !getPanelLayout().visible.tabs) useLayoutStore.getState().toggle("tabs");
        };
        const stopWatching = browserApi.watch({
            onOpened: (tab, chatId) => adopt(tab, chatId === null || chatId === useChatsStore.getState().activeChatId),
            onChanged: (tab) => {
                if (!useBrowserStore.getState().tabs[tab.id]) return;
                put(tab);
                const panelTab = usePanelTabsStore.getState().tabs.find((t) => t.id === tab.id);
                const title = tabTitle(tab);
                if (panelTab && (panelTab.title !== title || panelTab.detail !== tab.url)) {
                    panelTabs.update(tab.id, { title, detail: tab.url });
                }
            },
            onClosed: (id) => {
                drop(id);
                panelTabs.close(id, true);
            }
        });
        // Tabs an agent opened before this page was listening.
        void browserApi
            .list()
            .then((tabs) => tabs.forEach((tab) => adopt(tab, false)))
            .catch(() => {});
        // A panel tab that's gone takes its browser tab with it.
        const stopClosing = usePanelTabsStore.subscribe((state) => {
            const open = new Set(state.tabs.map((t) => t.id));
            for (const id of Object.keys(useBrowserStore.getState().tabs)) {
                if (open.has(id)) continue;
                drop(id);
                void browserApi.close(id).catch(() => {});
            }
        });
        return () => {
            stopWatching();
            stopClosing();
        };
    }, []);
}
