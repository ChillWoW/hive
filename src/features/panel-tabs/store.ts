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
    /** A file tab's file: `path` relative to `cwd`, `/`-separated. */
    file?: { cwd: string; path: string };
};

/**
 * Asked before a tab closes; true holds it open (it closes itself later,
 * e.g. once its unsaved changes are saved). Set by the editor.
 */
let closeGuard: ((tab: PanelTab) => boolean) | null = null;

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

/** `tabs` less the ones closing; any the guard holds open stay. */
function closing(tabs: PanelTab[], close: (tab: PanelTab, index: number) => boolean): PanelTab[] {
    return tabs.filter((tab, i) => !close(tab, i) || !!closeGuard?.(tab));
}

/** Panel tab actions, outside React too. */
export const panelTabs = {
    setCloseGuard: (guard: typeof closeGuard) => {
        closeGuard = guard;
    },
    /** Opens a tab just after the shown one and shows it; returns its id. */
    open: (tab: Omit<PanelTab, "id">): string => {
        const { tabs, activeId } = state();
        const id = crypto.randomUUID();
        const at = tabs.findIndex((t) => t.id === activeId);
        const next = [...tabs];
        next.splice(at < 0 ? tabs.length : at + 1, 0, { ...tab, id });
        setTabs(next, id);
        return id;
    },
    /** Changes a tab's title, detail, dirty mark or file. */
    update: (id: string, patch: Partial<Omit<PanelTab, "id" | "kind">>) => {
        const { tabs } = state();
        const at = tabs.findIndex((t) => t.id === id);
        const tab = tabs[at];
        if (!tab) return;
        const next = [...tabs];
        next[at] = { ...tab, ...patch };
        usePanelTabsStore.setState({ tabs: next });
    },
    select: (id: string) => usePanelTabsStore.setState({ activeId: id }),
    /**
     * Closing the shown tab shows its right neighbour, else its left.
     * `force` skips the guard (unsaved changes are thrown away).
     */
    close: (id: string, force = false) => {
        const { tabs } = state();
        const at = tabs.findIndex((t) => t.id === id);
        const tab = tabs[at];
        if (!tab || (!force && closeGuard?.(tab))) return;
        const rest = tabs.filter((t) => t.id !== id);
        setTabs(rest, undefined, rest[Math.min(at, rest.length - 1)]?.id);
    },
    closeOthers: (id: string) => setTabs(closing(state().tabs, (t) => t.id !== id), id),
    closeToRight: (id: string) => {
        const { tabs } = state();
        const at = tabs.findIndex((t) => t.id === id);
        setTabs(closing(tabs, (_, i) => i > at), undefined, id);
    },
    closeAll: () => setTabs(closing(state().tabs, () => true)),
    /** Moves the tab at `from` to index `to`. */
    move: (from: number, to: number) => {
        const next = [...state().tabs];
        const [tab] = next.splice(from, 1);
        if (!tab) return;
        next.splice(to, 0, tab);
        setTabs(next);
    }
};
