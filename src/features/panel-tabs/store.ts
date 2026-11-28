import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type PanelTabKind = "file" | "diff" | "terminal" | "output" | "history" | "commit" | "browser";

/**
 * A tab in the tabs panel: a file, a diff, a terminal, a background shell's
 * output, a folder's history, one commit, or a web page (a browser tab, whose
 * id is its backend tab's: `features/browser`).
 */
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
    /** A diff tab's folder: its checkout's uncommitted changes, or with `chatId` what that chat's latest turn changed there. */
    diff?: { cwd: string; chatId?: string };
    /** An output tab's background shell: chat `chatId`'s task, the file its output goes to, what it runs. */
    output?: { chatId: string; taskId: string; path: string; command?: string };
    /** A history tab's folder: its checkout's commits. */
    history?: { cwd: string };
    /** A commit tab's commit, in `cwd`'s checkout. */
    commit?: { cwd: string; sha: string };
    /** A terminal tab's folder (null: home), to start its shell in again after a restart. */
    terminal?: { cwd: string | null };
    /** A browser tab's page, to load again after a restart. */
    browser?: { url: string };
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

/**
 * Whether a tab comes back after a restart. Not a background shell's output
 * or a chat's last turn: what they show is gone by then.
 */
const kept = (tab: PanelTab) => tab.kind !== "output" && !tab.diff?.chatId;

/**
 * The tabs are saved on this device and come back after a restart, each
 * loading again when it's first shown: a file is read, a terminal starts a
 * new shell in its folder, a browser tab loads its page.
 */
export const usePanelTabsStore = create<PanelTabsState>()(
    persist((): PanelTabsState => ({ tabs: [], activeId: null }), {
        name: "outcode.panelTabs",
        version: 0,
        storage: createJSONStorage(() => localStorage),
        partialize: (s): PanelTabsState => ({
            // Unsaved text isn't kept, so neither is its mark.
            tabs: s.tabs.filter(kept).map((tab) => ({ ...tab, dirty: undefined })),
            activeId: s.activeId
        }),
        merge: (saved, current) => {
            const s = (saved ?? {}) as Partial<PanelTabsState>;
            const tabs = Array.isArray(s.tabs) ? s.tabs.filter((t) => t && typeof t.id === "string" && kept(t)) : [];
            const shown = tabs.some((t) => t.id === s.activeId);
            return { ...current, tabs, activeId: shown ? s.activeId! : (tabs[0]?.id ?? null) };
        }
    })
);

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
    /**
     * Opens a tab just after the shown one and shows it; returns its id
     * (`id` when given one). In the `background` it goes last and the shown
     * tab stays, unless there is none.
     */
    open: (tab: Omit<PanelTab, "id">, options: { id?: string; background?: boolean } = {}): string => {
        const { tabs, activeId } = state();
        const id = options.id ?? crypto.randomUUID();
        const at = tabs.findIndex((t) => t.id === activeId);
        const next = [...tabs];
        next.splice(at < 0 || options.background ? tabs.length : at + 1, 0, { ...tab, id });
        setTabs(next, options.background ? activeId : id);
        return id;
    },
    /** Changes a tab's title, detail, dirty mark, or what it shows. */
    update: (id: string, patch: Partial<Omit<PanelTab, "id" | "kind">>) => {
        const { tabs } = state();
        const at = tabs.findIndex((t) => t.id === id);
        const tab = tabs[at];
        if (!tab) return;
        const next = [...tabs];
        next[at] = { ...tab, ...patch };
        usePanelTabsStore.setState({ tabs: next });
    },
    /** Gives tab `id` the id `to`, where it is; false when it's gone. */
    rename: (id: string, to: string): boolean => {
        const { tabs, activeId } = state();
        if (!tabs.some((t) => t.id === id)) return false;
        usePanelTabsStore.setState({
            tabs: tabs.map((t) => (t.id === id ? { ...t, id: to } : t)),
            activeId: activeId === id ? to : activeId
        });
        return true;
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
