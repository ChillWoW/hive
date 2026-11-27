import { create } from "zustand";

export type PanelTabKind = "file" | "diff" | "terminal";

/** A tab in the tabs panel: a file, a diff or a terminal. */
export type PanelTab = {
    id: string;
    kind: PanelTabKind;
    title: string;
    /** Under the title in its tooltip: a file's or diff's path, a terminal's folder. */
    detail?: string;
    /** Unsaved changes: a dot stands in for its × until hovered. */
    dirty?: boolean;
};

type PanelTabsState = {
    /** In strip order. */
    tabs: PanelTab[];
    activeId: string | null;
};

export const usePanelTabsStore = create<PanelTabsState>()(() => ({ tabs: [], activeId: null }));

const state = () => usePanelTabsStore.getState();

/** Sets the tabs; a shown tab that's gone hands over to `fallback`, else the first. */
function setTabs(tabs: PanelTab[], activeId = state().activeId, fallback?: string | null) {
    const kept = tabs.some((t) => t.id === activeId);
    usePanelTabsStore.setState({
        tabs,
        activeId: kept ? activeId : (fallback ?? tabs[0]?.id ?? null)
    });
}

/** Panel tab actions, outside React too. */
export const panelTabs = {
    /** Opens a tab just after the shown one and shows it. */
    open: (tab: Omit<PanelTab, "id">) => {
        const { tabs, activeId } = state();
        const id = crypto.randomUUID();
        const at = tabs.findIndex((t) => t.id === activeId);
        const next = [...tabs];
        next.splice(at < 0 ? tabs.length : at + 1, 0, { ...tab, id });
        setTabs(next, id);
    },
    select: (id: string) => usePanelTabsStore.setState({ activeId: id }),
    /** Closing the shown tab shows its right neighbour, else its left. */
    close: (id: string) => {
        const { tabs } = state();
        const at = tabs.findIndex((t) => t.id === id);
        if (at < 0) return;
        const rest = tabs.filter((t) => t.id !== id);
        setTabs(rest, undefined, rest[Math.min(at, rest.length - 1)]?.id);
    },
    closeOthers: (id: string) => {
        setTabs(
            state().tabs.filter((t) => t.id === id),
            id
        );
    },
    closeToRight: (id: string) => {
        const { tabs } = state();
        setTabs(tabs.slice(0, tabs.findIndex((t) => t.id === id) + 1), undefined, id);
    },
    closeAll: () => setTabs([]),
    /** Moves the tab at `from` to index `to`. */
    move: (from: number, to: number) => {
        const next = [...state().tabs];
        const [tab] = next.splice(from, 1);
        if (!tab) return;
        next.splice(to, 0, tab);
        setTabs(next);
    }
};
