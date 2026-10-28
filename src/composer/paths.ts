/** The last segment of a path, either slash. */
export function folderName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).pop() || trimmed || path;
}
