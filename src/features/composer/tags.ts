/**
 * What the composer draws as a tag, and the sent prompt the same way: an
 * `@path` mention, a `$skill`, and a `/command` at the prompt's start.
 */
export type Tag =
    | { kind: "file"; path: string }
    | { kind: "skill"; name: string }
    | { kind: "command"; name: string };

export type FoundTag = { from: number; to: number; tag: Tag };

/**
 * A mention starts a word (or follows an opening bracket) and runs to the
 * closing quote, or to the next space less any punctuation closing the
 * sentence around it (`see @src/app.ts.`). `name@example.com` isn't one.
 */
const MENTION = /(?<![^\s([{])@(?:"([^"\n]+)"|([^\s"@]+?))(?=[.,;:!?)\]}]*(?:\s|$))/g;
/** A name ends in a letter, digit or `_`, so the sentence's punctuation stays out. */
const NAME = String.raw`[\p{L}_](?:[\p{L}\p{N}_:.-]*[\p{L}\p{N}_])?`;
const SKILL = new RegExp(String.raw`(?<![^\s([{])\$(${NAME})(?=[.,;:!?)\]}]*(?:\s|$))`, "gu");
const COMMAND = new RegExp(String.raw`^\s*(\/(${NAME}))(?=\s|$)`, "u");

/** Every tag in `text`, in order, none overlapping. */
export function findTags(text: string): FoundTag[] {
    const found: FoundTag[] = [];
    for (const m of text.matchAll(MENTION)) {
        found.push({ from: m.index, to: m.index + m[0].length, tag: { kind: "file", path: (m[1] ?? m[2])! } });
    }
    for (const m of text.matchAll(SKILL)) {
        found.push({ from: m.index, to: m.index + m[0].length, tag: { kind: "skill", name: m[1]! } });
    }
    const command = COMMAND.exec(text);
    if (command) {
        const to = command[0].length;
        found.push({ from: to - command[1]!.length, to, tag: { kind: "command", name: command[2]! } });
    }
    found.sort((a, b) => a.from - b.from || b.to - a.to);
    const kept: FoundTag[] = [];
    for (const f of found) {
        if (kept.length && f.from < kept[kept.length - 1]!.to) continue;
        kept.push(f);
    }
    return kept;
}

export type TagPiece = { text: string } | { tag: Tag; raw: string };

/** `text` as plain runs and the tags `tags` (from `findTags`) pick out of it. */
export function tagPieces(text: string, tags: FoundTag[]): TagPiece[] {
    const pieces: TagPiece[] = [];
    let last = 0;
    for (const { from, to, tag } of tags) {
        if (from > last) pieces.push({ text: text.slice(last, from) });
        pieces.push({ tag, raw: text.slice(from, to) });
        last = to;
    }
    if (last < text.length) pieces.push({ text: text.slice(last) });
    return pieces;
}
