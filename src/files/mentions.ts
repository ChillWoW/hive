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
const MENTION = /(?<![^\s([{])@(?:"([^"\n]+)"|([^\s"@]+?))(?=[.,;:!?)\]}]*(?:\s|$))/g;

export type MentionPiece = { text: string } | { path: string };

/** Text as runs of plain text and the paths it mentions, in order. */
export function splitMentions(text: string): MentionPiece[] {
    const pieces: MentionPiece[] = [];
    let last = 0;
    for (const match of text.matchAll(MENTION)) {
        if (match.index > last) pieces.push({ text: text.slice(last, match.index) });
        pieces.push({ path: (match[1] ?? match[2])! });
        last = match.index + match[0].length;
    }
    if (last < text.length) pieces.push({ text: text.slice(last) });
    return pieces;
}
