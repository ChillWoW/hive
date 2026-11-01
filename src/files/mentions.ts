/**
 * `@` mentions of files and folders, as they're written in a prompt: `@` and
 * the path relative to the chat's folder, quoted when it has a space in it.
 * A folder ends in `/`. The text goes to the agent as is; Claude Code (and
 * the model, for any harness) reads `@path` as a reference to that file.
 */

/** A path as it's written after `@`: quoted when a space would end it. */
export function fileMention(path: string): string {
    return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * A mention starts a word (or follows an opening bracket) and runs to the
 * closing quote, or to the next space less any punctuation closing the
 * sentence around it (`see @src/app.ts.`). `name@example.com` isn't one.
 */
export const MENTION = /(?<![^\s([{])@(?:"([^"\n]+)"|([^\s"@]+?))(?=[.,;:!?)\]}]*(?:\s|$))/g;
