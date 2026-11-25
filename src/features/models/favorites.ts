import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type FavoritesState = {
    /** Starred model ids, listed first in the model picker. */
    ids: string[];
    toggle: (id: string) => void;
};

/** Per device (localStorage). */
const useFavoritesStore = create<FavoritesState>()(
    persist(
        (set) => ({
            ids: [],
            toggle: (id) =>
                set((s) => ({ ids: s.ids.includes(id) ? s.ids.filter((f) => f !== id) : [...s.ids, id] }))
        }),
        { name: "outcode.favoriteModels", storage: createJSONStorage(() => localStorage) }
    )
);

/** Starred model ids, and a toggle. */
export function useFavoriteModels(): [string[], (id: string) => void] {
    return [useFavoritesStore((s) => s.ids), useFavoritesStore((s) => s.toggle)];
}
