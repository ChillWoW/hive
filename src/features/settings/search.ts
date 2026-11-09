import { createContext, useContext } from "react";

/** The active query, lowercased and trimmed; empty means show everything. */
export const SettingsQueryContext = createContext("");

export function useSettingsQuery(): string {
    return useContext(SettingsQueryContext);
}

/** Every word of the query must appear somewhere in the haystack. */
export function matchesQuery(
    query: string,
    ...haystack: (string | undefined)[]
): boolean {
    if (!query) return true;
    const text = haystack.filter(Boolean).join(" ").toLowerCase();
    return query.split(/\s+/).every((word) => text.includes(word));
}

/** `text` split so odd indexes are the matches of `query`'s words. */
export function splitMatches(text: string, query: string): string[] {
    const words = query
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (words.length === 0) return [text];
    return text.split(new RegExp(`(${words.join("|")})`, "gi"));
}
