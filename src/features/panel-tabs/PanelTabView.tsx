import { usePanelTabsStore } from "./store";

/** The shown tab's content, or a note that there's none. */
export function PanelTabView() {
    const tab = usePanelTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
    if (!tab) {
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted">
                No tabs open
            </div>
        );
    }
    // Files, diffs and terminals bring their own views.
    return <div role="tabpanel" className="min-h-0 flex-1 overflow-auto" />;
}
