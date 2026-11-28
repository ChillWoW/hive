import { panelTabs, usePanelTabsStore } from "@/features/panel-tabs/store";
import { toast } from "@/ui";
import { browserApi, type BrowserTab } from "./api";
import { isBlank, useBrowserStore } from "./store";

/**
 * Browser panel tabs saved from before a restart. Their backend tabs went
 * with the app, so each is dormant, under an id of its own, until it's first
 * shown: then a backend tab is opened on its page and it takes that one's id.
 */
const dormant = new Set<string>();
const reviving = new Map<string, Promise<void>>();
let sorted: Promise<void> = Promise.resolve();

export const putTab = (tab: BrowserTab) => useBrowserStore.setState((s) => ({ tabs: { ...s.tabs, [tab.id]: tab } }));

/**
 * Tells the saved panel tabs apart, given the backend's tabs: one whose
 * backend tab is still there (the page reloaded, not the app) keeps it, the
 * rest go dormant. Under new ids, as the backend hands theirs out again.
 */
export function sortSaved(live: Promise<BrowserTab[]>) {
    sorted = live.then((tabs) => {
        const ids = new Set(tabs.map((t) => t.id));
        for (const tab of usePanelTabsStore.getState().tabs) {
            if (tab.kind !== "browser" || ids.has(tab.id) || dormant.has(tab.id)) continue;
            const id = crypto.randomUUID();
            dormant.add(id);
            panelTabs.rename(tab.id, id);
        }
    });
    return sorted;
}

/** Once the saved tabs are sorted and no dormant one is mid-way to its backend tab: panel tab ids are settled. */
export async function settled() {
    await sorted;
    if (reviving.size > 0) await Promise.allSettled([...reviving.values()]);
}

/** Opens dormant tab `id`'s page, if it is one; its panel tab stays where it is. */
export function reviveBrowser(id: string) {
    void sorted.then(() => {
        if (!dormant.has(id) || reviving.has(id)) return;
        const url = usePanelTabsStore.getState().tabs.find((t) => t.id === id)?.browser?.url;
        const revival = browserApi
            .open(url && !isBlank(url) ? url : undefined)
            .then((tab) => {
                dormant.delete(id);
                // Closed meanwhile: its new browser tab goes too.
                if (panelTabs.rename(id, tab.id)) putTab(tab);
                else void browserApi.close(tab.id).catch(() => {});
            })
            .catch((error: unknown) => {
                toast.error({
                    title: "Couldn't reopen the browser tab",
                    description: error instanceof Error ? error.message : String(error)
                });
            })
            .finally(() => reviving.delete(id));
        reviving.set(id, revival);
    });
}
