import { useEffect } from "react";
import { chats, isBusy, useChatsStore } from "@/chats";
import { useSettingsStore } from "@/settings/store";
import { COMPACT_BEFORE_EXPIRY_MS, PROMPT_CACHE_TTL_MS, wantsIdleCompaction } from "./compaction";

/** Idle spells already compacted, by `chatId:lastMessageAt`; one try each. */
const done = new Set<string>();

/**
 * Claude's "Compact idle threads: before the cache expires" (after t3code):
 * a big Claude chat left idle gets `/compact` sent a few minutes before its
 * prompt cache would expire, so coming back doesn't re-read it uncached.
 * Only while Hive is open; a chat whose cache already expired is left to
 * the composer's Compact chip. Mounted in `App`.
 */
export function useIdleCompactionRuntime() {
    const mode = useSettingsStore((s) => s.settings.claude.idleCompaction);
    const list = useChatsStore((s) => s.chats);
    const sessions = useChatsStore((s) => s.sessions);

    useEffect(() => {
        if (mode !== "beforeCacheExpires") return;
        const timers: number[] = [];
        const now = Date.now();
        for (const chat of list) {
            const last = chat.lastMessageAt;
            if (last == null || !wantsIdleCompaction(chat)) continue;
            if (isBusy(sessions[chat.id]?.status)) continue;
            const key = `${chat.id}:${last}`;
            if (done.has(key)) continue;
            const expires = last + PROMPT_CACHE_TTL_MS;
            if (now >= expires) continue;
            const at = expires - COMPACT_BEFORE_EXPIRY_MS;
            timers.push(
                window.setTimeout(
                    () => {
                        done.add(key);
                        void chats.send({ chatId: chat.id }, "/compact").catch(() => {});
                    },
                    Math.max(0, at - now)
                )
            );
        }
        return () => timers.forEach((t) => window.clearTimeout(t));
    }, [mode, list, sessions]);
}
