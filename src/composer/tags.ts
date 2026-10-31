import { MENTION } from "@/files/mentions";
import { commentTokens } from "@/review/comments";

/**
 * What the composer draws as a tag, and the sent prompt the same way: an
 * `@path` mention, a `$skill`, a `/command` at the prompt's start, and a diff
 * comment (its token in a draft, `[comment N]` once sent).
 */
export type Tag =
    | { kind: "file"; path: string }
    | { kind: "skill"; name: string }
    | { kind: "command"; name: string }
    /** A draft's comment by id, or a sent one by its number. */
    | { kind: "comment"; ref: string };

export type FoundTag = { from: number; to: number; tag: Tag };

/** A name ends in a letter, digit or `_`, so the sentence's punctuation stays out. */
const NAME = String.raw`[\p{L}_](?:[\p{L}\p{N}_:.-]*[\p{L}\p{N}_])?`;
const SKILL = new RegExp(String.raw`(?<![^\s([{])\$(${NAME})(?=[.,;:!?)\]}]*(?:\s|$))`, "gu");
const COMMAND = new RegExp(String.raw`^\s*(\/(${NAME}))(?=\s|$)`, "u");
const SENT_COMMENT = /\[comment (\d+)\]/g;

/**
 * Every tag in `text`, in order, none overlapping. `sent` reads comments as
 * `[comment N]` rather than draft tokens.
 */
export function findTags(text: string, { sent = false } = {}): FoundTag[] {
    const found: FoundTag[] = [];
    for (const m of text.matchAll(MENTION)) {
        found.push({
            from: m.index,
            to: m.index + m[0].length,
            tag: { kind: "file", path: (m[1] ?? m[2])! }
        });
    }
    for (const m of text.matchAll(SKILL)) {
        found.push({ from: m.index, to: m.index + m[0].length, tag: { kind: "skill", name: m[1]! } });
    }
    const command = COMMAND.exec(text);
    if (command) {
        const to = command[0].length;
        found.push({ from: to - command[1]!.length, to, tag: { kind: "command", name: command[2]! } });
    }
    if (sent) {
        for (const m of text.matchAll(SENT_COMMENT)) {
            found.push({ from: m.index, to: m.index + m[0].length, tag: { kind: "comment", ref: m[1]! } });
        }
    } else {
        for (const t of commentTokens(text)) {
            found.push({ from: t.from, to: t.to, tag: { kind: "comment", ref: t.id } });
        }
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

export const sameTag = (a: Tag, b: Tag) => JSON.stringify(a) === JSON.stringify(b);
