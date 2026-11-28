import { listen } from "@tauri-apps/api/event";
import type { Attachment } from "@/proto";
import { backend } from "@/lib/backend";
import { isTauri } from "@/lib/platform";

/** A page size a tab is shown at, in CSS pixels, whatever room the panel has. */
export type Viewport = { width: number; height: number };

/** A browser tab as the backend reports it (`src-tauri/src/browser.rs`). */
export type BrowserTab = {
    id: string;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    favicon: string | null;
    /** Set while the tab is shown at a fixed page size rather than the panel's. */
    viewport: Viewport | null;
    /** The chat whose agent is acting on it right now. */
    agent: string | null;
};

/** An element the user picked in a page. */
export type Picked = {
    selector: string;
    tag: string;
    text: string;
    html: string;
    url: string;
    /** Its picture, where screenshots are supported. */
    attachment: Attachment | null;
};

/** Where a tab goes over the page: physical pixels from the window's corner. */
export type Placement = { x: number; y: number; width: number; height: number; pageWidth: number | null };

export type BrowserEvents = {
    /** A tab opened; `chatId` is the chat whose agent opened it, null for the user. */
    onOpened: (tab: BrowserTab, chatId: string | null) => void;
    onChanged: (tab: BrowserTab) => void;
    onClosed: (id: string) => void;
};

export const browserApi = {
    /** Opens a tab on what was typed (a URL, a host, a search); a blank one without it. */
    open: (url?: string) => backend<BrowserTab>("browser_open", { url: url ?? null }),
    /** The tabs open now. */
    list: () => backend<BrowserTab[]>("browser_list", undefined, () => []),
    close: (id: string) => backend<void>("browser_close", { id }),
    navigate: (id: string, url: string) => backend<void>("browser_navigate", { id, url }),
    go: (id: string, go: "back" | "forward" | "reload" | "stop") => backend<void>("browser_go", { id, go }),
    place: (id: string, at: Placement) => backend<void>("browser_place", { id, ...at }),
    hide: (id: string) => backend<void>("browser_hide", { id }),
    /** Hides the tab; its picture (JPEG) to show meanwhile, empty where there's none. */
    freeze: (id: string) => backend<ArrayBuffer>("browser_freeze", { id }),
    setViewport: (id: string, viewport: Viewport | null) => backend<void>("browser_set_viewport", { id, viewport }),
    devtools: (id: string) => backend<void>("browser_devtools", { id }),
    /** A picture of the page, kept as an attachment. */
    capture: (id: string) => backend<Attachment>("browser_capture", { id }),
    /** Lets the user click an element in the page; null when they back out. */
    pick: (id: string) => backend<Picked | null>("browser_pick", { id }),
    cancelPick: (id: string) => backend<void>("browser_pick_cancel", { id }),

    /** Follows the tabs as they open, change and close. Returns what stops it. */
    watch(events: BrowserEvents): () => void {
        if (!isTauri) return () => {};
        const stops = [
            listen<{ tab: BrowserTab; chatId: string | null }>("browser:opened", (e) =>
                events.onOpened(e.payload.tab, e.payload.chatId)
            ),
            listen<BrowserTab>("browser:changed", (e) => events.onChanged(e.payload)),
            listen<string>("browser:closed", (e) => events.onClosed(e.payload))
        ];
        return () => {
            for (const stop of stops) void stop.then((off) => off());
        };
    }
};
