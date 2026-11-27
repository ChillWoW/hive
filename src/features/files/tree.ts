import type { WorkspaceEntry } from "@/proto";

/** The folder `path` is in, `""` at the root. */
export const parentOf = (path: string) => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
};

/** The last segment of a `/`-separated relative path. */
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Every folder `path` sits in, outermost first. */
export function ancestorsOf(path: string): string[] {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Each folder's entries, by its path (`""` for the root). The listing comes
 * shallowest first, folders before files, then by path, so each folder's
 * entries land in that order too.
 */
export function childrenByFolder(entries: readonly WorkspaceEntry[]): Map<string, WorkspaceEntry[]> {
    const children = new Map<string, WorkspaceEntry[]>();
    for (const entry of entries) {
        const parent = parentOf(entry.path);
        let list = children.get(parent);
        if (!list) {
            list = [];
            children.set(parent, list);
        }
        list.push(entry);
    }
    return children;
}

/** A row the tree shows: an entry, how deep it is, and whether it's an open folder. */
export type TreeRow = { entry: WorkspaceEntry; depth: number; open: boolean };

/** The rows shown with `expanded` folders open, top to bottom. */
export function visibleRows(children: Map<string, WorkspaceEntry[]>, expanded: ReadonlySet<string>): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (folder: string, depth: number) => {
        for (const entry of children.get(folder) ?? []) {
            const open = entry.dir && expanded.has(entry.path);
            rows.push({ entry, depth, open });
            if (open) walk(entry.path, depth + 1);
        }
    };
    walk("", 0);
    return rows;
}
