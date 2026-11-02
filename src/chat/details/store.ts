import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Whether the chat details card floats in the thread (persisted as `hive.chatDetails`). */
export const useChatDetailsStore = create<{ open: boolean; toggle: () => void }>()(
    persist(
        (set) => ({
            open: false,
            toggle: () => set((s) => ({ open: !s.open }))
        }),
        { name: "hive.chatDetails" }
    )
);
