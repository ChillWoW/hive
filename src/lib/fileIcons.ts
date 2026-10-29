import {
    file as defaultFile,
    fileExtensions,
    fileNames,
    folder as defaultFolder,
    folderExpanded as defaultFolderExpanded,
    folderNames,
    folderNamesExpanded,
    iconDefinitions
} from "material-icon-theme/dist/material-icons.json";

/**
 * File and folder icons from `material-icon-theme`, resolved the way VS Code
 * resolves them from the theme's manifest: an exact file (or folder) name
 * first, then the longest matching extension — `d.ts` before `ts` — and
 * otherwise the generic icon. As in Desktop/agent.
 *
 * Every SVG is emitted as its own asset and only its URL is bundled, so an
 * icon costs a request the first time it is drawn and nothing before. The
 * light and high-contrast variants are ignored; the app is always dark.
 */

// `exhaustive`, or the glob skips anything under `node_modules` and finds nothing.
const urls = import.meta.glob<string>("/node_modules/material-icon-theme/icons/*.svg", {
    eager: true,
    query: "?url",
    import: "default",
    exhaustive: true
});

const definitions: Record<string, { iconPath: string }> = iconDefinitions;

function urlOf(icon: string): string {
    const path = definitions[icon]?.iconPath ?? "";
    const file = path.slice(path.lastIndexOf("/") + 1);
    return urls[`/node_modules/material-icon-theme/icons/${file}`] ?? "";
}

function lookup(table: Record<string, string>, key: string): string | undefined {
    return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The last segment of a name or path, lowercased as the manifest's keys are. */
function baseName(name: string): string {
    const trimmed = name.replace(/[\\/]+$/, "");
    return trimmed
        .slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1)
        .toLowerCase();
}

/** The icon's name in the theme for a file. */
function fileIcon(name: string): string {
    const base = baseName(name);
    const exact = lookup(fileNames, base);
    if (exact) return exact;
    // `a.test.ts` tries `test.ts`, then `ts`: longest extension first.
    for (let dot = base.indexOf("."); dot !== -1; dot = base.indexOf(".", dot + 1)) {
        const icon = lookup(fileExtensions, base.slice(dot + 1));
        if (icon) return icon;
    }
    return defaultFile;
}

function folderIcon(name: string, open: boolean): string {
    return (
        lookup(open ? folderNamesExpanded : folderNames, baseName(name)) ??
        (open ? defaultFolderExpanded : defaultFolder)
    );
}

export type FileIconOptions = {
    /** Resolve as a folder rather than a file. */
    folder?: boolean;
    /** For a folder: the expanded variant. */
    open?: boolean;
};

/** URL of the icon for a file or folder name (or path). */
export function fileIconUrl(name: string, { folder, open = false }: FileIconOptions = {}): string {
    return urlOf(folder ? folderIcon(name, open) : fileIcon(name));
}
