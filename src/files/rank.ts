import type { WorkspaceEntry } from "@/proto";
import { fuzzyScore, rankBy } from "@/lib/fuzzy";

/**
 * How well a path matches: by the whole path, a path that starts with the
 * query (`src/comp`) ahead of the rest, else by its name when that scores
 * better, since a name is what people type. Shallower first among equals.
 */
export function scoreEntry(query: string, entry: WorkspaceEntry): number | null {
    const path = entry.path;
    const byPath = fuzzyScore(query, path);
    if (byPath === null) return null;
    const depth = path.split("/").length - 1;
    if (path.toLowerCase().startsWith(query.toLowerCase())) return byPath + 100 - depth;
    const byName = fuzzyScore(query, path.slice(path.lastIndexOf("/") + 1));
    return (byName === null ? byPath : Math.max(byPath, byName + 20)) - depth * 0.5;
}

/** The best `limit` entries for `query`, best first. */
export const rankEntries = (query: string, entries: readonly WorkspaceEntry[], limit: number) =>
    rankBy(entries, (entry) => scoreEntry(query, entry), limit);
