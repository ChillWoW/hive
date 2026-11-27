/**
 * A path as it's written after `@`, relative to the chat's folder: quoted
 * when a space would end it. The text goes to the agent as is; Claude Code
 * (and the model, for any harness) reads `@path` as a reference to that file.
 */
export function fileMention(path: string): string {
    return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}
