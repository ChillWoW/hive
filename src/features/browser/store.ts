import { create } from "zustand";
import type { BrowserTab } from "./api";

type BrowserState = {
    /** The open browser tabs, by id (their panel tab's id too). */
    tabs: Record<string, BrowserTab>;
    /** The tab the user is picking an element in. */
    picking: string | null;
};

/** The browser tabs as the backend last reported them; it owns them (`src-tauri/src/browser.rs`). */
export const useBrowserStore = create<BrowserState>()(() => ({ tabs: {}, picking: null }));

export const useBrowserTab = (id: string) => useBrowserStore((s) => s.tabs[id]);

/** A tab's name in the strip: its page's title, else its host. */
export function tabTitle(tab: Pick<BrowserTab, "title" | "url">): string {
    if (tab.title.trim()) return tab.title.trim();
    try {
        const url = new URL(tab.url);
        if (url.host) return url.host;
    } catch {
        // Not a URL yet.
    }
    return "New tab";
}

/** Whether `url` is the blank page a new tab starts on. */
export const isBlank = (url: string) => !url || url === "about:blank";
