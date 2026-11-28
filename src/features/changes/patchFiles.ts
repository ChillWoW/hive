import { useState } from "react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

/** A changed file: its parsed diff and line counts. */
export type Changed = { diff: FileDiffMetadata; additions: number; deletions: number };

export function parsePatch(patch: string): Changed[] {
    if (!patch.trim()) return [];
    const files = parsePatchFiles(patch).flatMap((p) => p.files);
    return files.map((diff) => {
        let additions = 0;
        let deletions = 0;
        for (const hunk of diff.hunks) {
            additions += hunk.additionLines;
            deletions += hunk.deletionLines;
        }
        return { diff, additions, deletions };
    });
}

/** Which files are collapsed, by name: all start collapsed, and a file that comes back keeps its state. */
export function useCollapsedFiles(files: Changed[]) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const allCollapsed = files.every((f) => !expanded[f.diff.name]);
    return {
        isCollapsed: (name: string) => !expanded[name],
        allCollapsed,
        toggle: (name: string) => setExpanded((e) => ({ ...e, [name]: !e[name] })),
        toggleAll: () =>
            setExpanded(allCollapsed ? Object.fromEntries(files.map((f) => [f.diff.name, true])) : {})
    };
}
