/**
 * How well `query` matches `target` as a fuzzy subsequence, or `null` when its
 * characters don't all appear in order. Case-insensitive. Higher is better:
 * characters that follow one another score more than scattered ones, and a
 * character at the start of a word — after `/`, `.`, `-`, `_`, a space or a
 * lower-to-upper case change — more than one inside it, so `cin` finds
 * `ChatInput` before `cabin`.
 *
 * Greedy — each query character takes the first place it fits — which misses
 * the best alignment now and then but costs one pass.
 */
export function fuzzyScore(query: string, target: string): number | null {
    if (query === "") return 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    let score = 0;
    let qi = 0;
    let previous = -2;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] !== q[qi]) continue;
        score += 1;
        if (ti === previous + 1) score += 4;
        if (isWordStart(target, ti)) score += 3;
        previous = ti;
        qi++;
    }
    if (qi < q.length) return null;
    // Of two equal matches, the shorter target is the closer one.
    return score - target.length * 0.01;
}

function isWordStart(text: string, i: number): boolean {
    if (i === 0) return true;
    const before = text[i - 1]!;
    const at = text[i]!;
    return (
        "/\\.-_ ".includes(before) ||
        (before === before.toLowerCase() && at !== at.toLowerCase())
    );
}

/**
 * The best `limit` of `items` that `score` doesn't reject, best first, in
 * the order they came for equal scores.
 */
export function rankBy<T>(
    items: readonly T[],
    score: (item: T) => number | null,
    limit = Infinity
): T[] {
    const scored: { item: T; score: number }[] = [];
    for (const item of items) {
        const s = score(item);
        if (s !== null) scored.push({ item, score: s });
    }
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ item }) => item);
}
