/** `84,000` as `84k`, `1,200,000` as `1.2M`. */
export function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
}
