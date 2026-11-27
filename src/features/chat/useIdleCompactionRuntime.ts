import { useEffect } from "react";
import { chatsApi } from "@/features/chats/api";
import { useChatsStore } from "@/features/chats/store";
import {
    COMPACT_BEFORE_EXPIRY_MS,
    PROMPT_CACHE_TTL_MS,
    useCompactionSettings,
    wantsIdleCompaction
} from "./compaction";

/** Idle spells already compacted, by `chatId:lastMessageAt`; one try each. */
const done = new Set<string>();

/**
 * Claude's "Idle chats: compact before the cache expires": a big Claude
 * chat left idle gets `/compact` sent a few minutes before its prompt cache
 * would expire, so coming back doesn't re-read it uncached. Only while
 * Outcode is open; a chat whose cache already expired is left to the notice
 * over the composer (`IdleCompactNotice`). Mounted in `App`.
 */
export function useIdleCompactionRuntime() {
    const { idle } = useCompactionSettings();
    const list = useChatsStore((s) => s.chats);
    const sessions = useChatsStore((s) => s.sessions);

    useEffect(() => {
        if (idle !== "before-cache-expires") return;
        const timers: number[] = [];
        const now = Date.now();
        for (const chat of list) {
            const last = chat.lastMessageAt;
            if (last == null || !wantsIdleCompaction(chat)) continue;
            if (sessions[chat.id]?.working) continue;
            const key = `${chat.id}:${last}`;
            if (done.has(key)) continue;
            const expires = last + PROMPT_CACHE_TTL_MS;
            if (now >= expires) continue;
            const at = expires - COMPACT_BEFORE_EXPIRY_MS;
            timers.push(
                window.setTimeout(
                    () => {
                        done.add(key);
                        void chatsApi.send(chat.id, "/compact").catch(() => {});
                    },
                    Math.max(0, at - now)
                )
            );
        }
        return () => timers.forEach((t) => window.clearTimeout(t));
    }, [idle, list, sessions]);
}
