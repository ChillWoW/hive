import type { Chat, HarnessId } from "@/proto";

/**
 * Claude compacts this far short of its `autoCompactWindow` (Claude Code
 * reports a 150,000 window as a 117,000 threshold, for every model).
 */
const AUTO_COMPACT_RESERVE = 33_000;

/**
 * Where a chat's agent compacts by itself, in tokens, when the user set
 * Claude's window (Settings › Providers) below the model's own; undefined
 * when it's the CLI's default.
 */
export function autoCompactAt(
    harness: HarnessId | undefined,
    setting: number | null,
    capacity: number | undefined
): number | undefined {
    if (harness !== "claude-code" || !setting) return undefined;
    if (capacity && setting >= capacity) return undefined;
    return setting - AUTO_COMPACT_RESERVE;
}

/** Below this, a stale chat isn't worth compacting (Claude's own idle default). */
export const STALE_COMPACT_MIN_TOKENS = 200_000;

/**
 * How long Claude's prompt cache outlives a turn: an hour on a subscription
 * (5 minutes with an API key).
 */
export const PROMPT_CACHE_TTL_MS = 60 * 60_000;

/** Past the cache's life, for "on return": the clocks aren't exact. */
const STALE_AFTER_MS = PROMPT_CACHE_TTL_MS + 10 * 60_000;

/** How long before the cache expires "before it expires" compacts. */
export const COMPACT_BEFORE_EXPIRY_MS = 5 * 60_000;

/**
 * A Claude chat big enough, and idle long enough for its prompt cache to
 * have expired, that the next prompt would re-read it all at full price.
 */
export function isStaleForCompact(chat: Chat | undefined, now: number): boolean {
    if (!chat || chat.config.harness !== "claude-code") return false;
    if ((chat.context?.tokens ?? 0) < STALE_COMPACT_MIN_TOKENS) return false;
    const last = chat.lastMessageAt;
    return last != null && now - last >= STALE_AFTER_MS;
}

/** A Claude chat big enough to be worth compacting while idle. */
export function wantsIdleCompaction(chat: Chat): boolean {
    return (
        chat.config.harness === "claude-code" &&
        !chat.archived &&
        !!chat.harnessSessionId &&
        (chat.context?.tokens ?? 0) >= STALE_COMPACT_MIN_TOKENS
    );
}
