import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** How many prompts are kept. */
const LIMIT = 200;

type PromptHistoryState = {
    /** Sent prompts, newest first; the same text only once. */
    entries: string[];
    remember: (prompt: string) => void;
};

/**
 * Prompts sent from any composer on this device, for ↑/↓ in an empty field
 * (shell-style). Persisted as `hive.promptHistory`.
 */
export const usePromptHistory = create<PromptHistoryState>()(
    persist(
        (set) => ({
            entries: [],
            remember: (prompt) => {
                const text = prompt.trim();
                if (!text) return;
                set((s) => ({
                    entries: [text, ...s.entries.filter((e) => e !== text)].slice(0, LIMIT)
                }));
            }
        }),
        {
            name: "hive.promptHistory",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ entries: s.entries }),
            merge: (saved, current) => {
                const entries = (saved as { entries?: unknown } | undefined)?.entries;
                return {
                    ...current,
                    entries: Array.isArray(entries)
                        ? entries.filter((e): e is string => typeof e === "string").slice(0, LIMIT)
                        : current.entries
                };
            }
        }
    )
);
