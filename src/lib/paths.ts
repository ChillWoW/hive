/** The last segment of a path, either slash, ignoring a trailing one. */
export function baseName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, "");
    return trimmed.split(/[\\/]/).pop() || trimmed || path;
}
