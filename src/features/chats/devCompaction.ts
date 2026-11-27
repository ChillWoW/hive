/**
 * Dev builds can pose a chat in each state of compaction: `?compact=<state>`
 * in the URL pins a "Compaction · <state>" chat to the top of the sidebar
 * (`dev.ts` seeds it, under `bun run dev`) and sets what that state needs
 * of Settings › Providers › Claude (`chat/compaction.ts`).
 *
 * - `stale`: idle past its prompt cache; the notice over the composer.
 * - `soon`: compacts by itself a few seconds after loading.
 * - `auto`: close to the auto-compact point; its tick in the context card.
 * - `full`: a context window nearly full.
 * - `running`: a compaction that never ends (Stop ends it).
 * - `failed`: `/compact` fails.
 */
export const DEV_COMPACT_STATES = ["stale", "soon", "auto", "full", "running", "failed"] as const;

export type DevCompact = (typeof DEV_COMPACT_STATES)[number];

function read(): DevCompact | null {
    if (!import.meta.env.DEV || typeof window === "undefined") return null;
    const value = new URLSearchParams(window.location.search).get("compact");
    return DEV_COMPACT_STATES.find((state) => state === value) ?? null;
}

/** The state asked for in the URL, if any; never in a release build. */
export const devCompact: DevCompact | null = read();

/** How long after loading `soon`'s chat compacts. */
export const DEV_COMPACT_SOON_MS = 6_000;
