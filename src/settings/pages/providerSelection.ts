import { create } from "zustand";
import type { HarnessId } from "@/proto";
import { settings } from "../store";

/** The provider Settings › Providers shows; null is the first one listed. */
export const useProviderSelection = create<{
    selected: HarnessId | null;
    select: (id: HarnessId) => void;
}>()((set) => ({
    selected: null,
    select: (selected) => set({ selected })
}));

/** Opens Settings › Providers on `id` (e.g. a model picker row whose CLI isn't installed). */
export function openProviderSettings(id: HarnessId) {
    useProviderSelection.getState().select(id);
    settings.open("providers");
}
