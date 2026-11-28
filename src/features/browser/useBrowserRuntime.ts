import { useEffect } from "react";
import { useChatsStore } from "@/features/chats";
import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { useSettingsStore } from "@/features/settings/store";
import { ACTIONS, useShortcut } from "@/keybindings";
import { canonical, keydownOf } from "@/keybindings/shortcut";
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

    // A tab's page is another webview and keeps its keys: it's told which
    // are the app's, to hand over. Not the ones a page has its own use for
    // (Refresh reloads the page there).
    const keyboard = useSettingsStore((s) => s.settings.keyboard);
    useEffect(() => {
        const shortcuts = ACTIONS.filter((a) => a.scope === "global" && !a.shellKeeps)
            .map((a) => canonical(keyboard[a.id]))
            .filter((s): s is string => s !== null);
        void browserApi.setShortcuts(shortcuts).catch(() => {});
    }, [keyboard]);

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
            },
            // Pressed as if on the tab's own view: its close-tab closes this tab, the rest go on to the app.
            onKey: (id, key) => {
                const view = document.querySelector(`[data-browser-view="${CSS.escape(id)}"]`) ?? document.body;
                view.dispatchEvent(keydownOf({ ...key, ctrl: false }));
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
