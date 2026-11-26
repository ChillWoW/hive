import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { chats, useChatsStore } from "@/features/chats";

/** A top bar tab: the chat it shows, or null for the new-chat view (one at most). */
export type Tab = string | null;

type TabsState = {
    /** In strip order; never empty. The shown one is the chats store's `activeChatId`. */
    tabs: Tab[];
};

export const useTabsStore = create<TabsState>()(
    persist(() => ({ tabs: [] as Tab[] }), {
        name: "outcode.tabs",
        storage: createJSONStorage(() => localStorage)
    })
);

const shown = () => useChatsStore.getState().activeChatId;
const list = () => useTabsStore.getState().tabs;
const setTabs = (tabs: Tab[]) => useTabsStore.setState({ tabs: tabs.length > 0 ? tabs : [null] });

/**
 * `tabs` with `chatId` in one: it's already there, or the new-chat tab it was
 * opened from turns into it, or it opens just after `from`'s tab.
 */
function place(tabs: Tab[], chatId: Tab, from: Tab | undefined): Tab[] {
    if (tabs.includes(chatId)) return tabs;
    const at = from === undefined ? -1 : tabs.indexOf(from);
    if (from === null && at >= 0 && chatId !== null) return tabs.map((t, i) => (i === at ? chatId : t));
    const next = [...tabs];
    next.splice(at < 0 ? tabs.length : at + 1, 0, chatId);
    return next;
}

// The shown chat always has a tab, from the first frame.
setTabs(place(list(), shown(), undefined));

useChatsStore.subscribe((s, before) => {
    const tabs = list();
    if (s.loaded && s.chats !== before.chats) {
        const ids = new Set(s.chats.map((c) => c.id));
        const kept = tabs.filter((t) => t === null || ids.has(t));
        if (kept.length < tabs.length) {
            setTabs(kept);
            // The shown chat was deleted: its neighbour shows instead of the new-chat view.
            const lost = before.activeChatId;
            if (lost && !ids.has(lost) && s.activeChatId === null) {
                const at = tabs.indexOf(lost);
                const next =
                    tabs.slice(at + 1).find((t) => kept.includes(t)) ??
                    tabs.slice(0, Math.max(at, 0)).findLast((t) => kept.includes(t)) ??
                    null;
                // After this change has reached every listener.
                queueMicrotask(() => chats.select(next));
            }
            return;
        }
    }
    if (s.activeChatId !== before.activeChatId) {
        setTabs(place(tabs, s.activeChatId, before.activeChatId));
    }
});

/** Tab actions, outside React too. Showing a tab is `chats.select`. */
export const tabs = {
    /** Opens the new-chat view: its tab if there is one, else a new one. */
    openNew: () => chats.startNew(),
    /** Closes a tab; closing the shown one shows its right neighbour, else its left. */
    close: (tab: Tab) => {
        const current = list();
        const at = current.indexOf(tab);
        if (at < 0) return;
        const rest = current.filter((t) => t !== tab);
        setTabs(rest);
        if (tab === shown()) chats.select(rest[Math.min(at, rest.length - 1)] ?? null);
    },
    closeOthers: (tab: Tab) => {
        setTabs([tab]);
        if (tab !== shown()) chats.select(tab);
    },
    closeToRight: (tab: Tab) => {
        const current = list();
        const rest = current.slice(0, current.indexOf(tab) + 1);
        setTabs(rest);
        if (!rest.includes(shown())) chats.select(tab);
    },
    /** Moves the tab at `from` to index `to`. */
    move: (from: number, to: number) => {
        const next = [...list()];
        const [tab] = next.splice(from, 1);
        if (tab === undefined) return;
        next.splice(to, 0, tab);
        setTabs(next);
    },
    /** Shows the next (1) or previous (-1) tab, wrapping around. False with one tab. */
    cycle: (step: 1 | -1) => {
        const current = list();
        if (current.length < 2) return false;
        const at = current.indexOf(shown());
        chats.select(current[(at + step + current.length) % current.length] ?? null);
    }
};

/** Whether the shown tab is the only one and the new-chat view: nothing to close. */
export const isLoneNewTab = (tabs: Tab[]) => tabs.length === 1 && tabs[0] === null;
