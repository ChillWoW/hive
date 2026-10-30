import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How many recent files and chats are remembered. */
const RECENT_LIMIT = 30;

export type RecentFile = { cwd: string; path: string; at: number };

type PaletteState = {
    isOpen: boolean;
    /** Files opened in a tab, most recent first. */
    files: RecentFile[];
    /** Chats opened, by id, most recent first. */
    chats: string[];
    setOpen: (open: boolean) => void;
    toggle: () => void;
};

/**
 * The command palette: open or not, and what it lists as recent. Kept free
 * of other app modules, since `openFileTab` records into it.
 */
export const usePaletteStore = create<PaletteState>()(
    persist(
        (set) => ({
            isOpen: false,
            files: [],
            chats: [],
            setOpen: (isOpen) => set({ isOpen }),
            toggle: () => set((s) => ({ isOpen: !s.isOpen }))
        }),
        {
            name: "hive.palette",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ files: s.files, chats: s.chats })
        }
    )
);

/** Puts `path` of `cwd` at the top of the recent files. */
export function rememberFile(cwd: string, path: string) {
    usePaletteStore.setState((s) => ({
        files: [
            { cwd, path, at: Date.now() },
            ...s.files.filter((f) => f.cwd !== cwd || f.path !== path)
        ].slice(0, RECENT_LIMIT)
    }));
}

/** Puts a chat at the top of the recent chats. */
export function rememberChat(id: string) {
    usePaletteStore.setState((s) =>
        s.chats[0] === id
            ? s
            : { chats: [id, ...s.chats.filter((c) => c !== id)].slice(0, RECENT_LIMIT) }
    );
}

/** Drops chats that no longer exist. */
export function pruneRecentChats(exists: (id: string) => boolean) {
    usePaletteStore.setState((s) => {
        const chats = s.chats.filter(exists);
        return chats.length === s.chats.length ? s : { chats };
    });
}

export const palette = {
    open: () => usePaletteStore.getState().setOpen(true),
    close: () => usePaletteStore.getState().setOpen(false),
    toggle: () => usePaletteStore.getState().toggle()
};
