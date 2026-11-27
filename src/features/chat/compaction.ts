import type { Chat, HarnessId } from "@/proto";
import { devCompact } from "@/features/chats/devCompaction";
import { useSettingsStore, type IdleCompaction } from "@/features/settings";

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
    setting: number,
    capacity: number | undefined
): number | undefined {
    if (harness !== "claude" || !setting) return undefined;
    if (capacity && setting >= capacity) return undefined;
    return Math.max(setting - AUTO_COMPACT_RESERVE, 0) || undefined;
}

/** Below this, an idle chat isn't worth compacting (Claude's own idle default). */
export const IDLE_COMPACT_MIN_TOKENS = 200_000;

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
    if (!chat || chat.config.harness !== "claude") return false;
    if ((chat.context?.tokens ?? 0) < IDLE_COMPACT_MIN_TOKENS) return false;
    const last = chat.lastMessageAt;
    return last != null && now - last >= STALE_AFTER_MS;
}

/** A Claude chat big enough to be worth compacting while idle. */
export function wantsIdleCompaction(chat: Chat): boolean {
    return (
        chat.config.harness === "claude" &&
        !chat.archived &&
        !!chat.sessionId &&
        (chat.context?.tokens ?? 0) >= IDLE_COMPACT_MIN_TOKENS
    );
}

// What `?compact=` (dev builds) needs of the settings to show its state.
const DEV_MODE: IdleCompaction | undefined =
    devCompact === "stale" ? "on-return" : devCompact === "soon" ? "before-cache-expires" : undefined;
const DEV_WINDOW = devCompact === "auto" ? 300_000 : undefined;

/** Claude's compaction settings: what idle chats get, and its `autoCompactWindow`. */
export function useCompactionSettings(): { idle: IdleCompaction; window: number } {
    const idle = useSettingsStore((s) => s.settings.claude.idleCompaction);
    const window = useSettingsStore((s) => s.settings.claude.autoCompactWindow);
    return { idle: DEV_MODE ?? idle, window: DEV_WINDOW ?? window };
}
