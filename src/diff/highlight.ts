import type { CSSProperties } from "react";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree, tagHighlighter } from "@lezer/highlight";
import { HIGHLIGHT_SPECS } from "@/editor/theme";
import type { FileDiff, PatchLine } from "./patch";

/** A coloured stretch of one line, by offsets into its text. */
export type Span = { from: number; to: number; style: CSSProperties };

// The editor's colours, as classes the highlighter hands back (`h0 h3`) and
// the inline styles they stand for.
const highlighter = tagHighlighter(
    HIGHLIGHT_SPECS.map((spec, i) => ({ tag: spec.tag, class: `h${i}` }))
);
const SPEC_STYLES = HIGHLIGHT_SPECS.map(({ tag: _tag, ...style }) => style as CSSProperties);
const styles = new Map<string, CSSProperties>();
function styleOf(classes: string): CSSProperties {
    let style = styles.get(classes);
    if (!style) {
        style = Object.assign(
            {},
            ...classes.split(" ").map((c) => SPEC_STYLES[Number(c.slice(1))] ?? {})
        ) as CSSProperties;
        styles.set(classes, style);
    }
    return style;
}

/** Past this many diff lines a file isn't highlighted. */
const MAX_LINES = 5000;
const CACHE_SIZE = 200;
const cache = new Map<string, Promise<Span[][] | null>>();

/** Each line's spans for `lines`, read as one document of `path`'s language. */
function highlightDoc(path: string, lines: string[]): Promise<Span[][] | null> {
    const key = `${path}\0${lines.join("\n")}`;
    let result = cache.get(key);
    if (result) {
        // Most recently used last.
        cache.delete(key);
        cache.set(key, result);
        return result;
    }
    result = run(path, lines).catch(() => null);
    cache.set(key, result);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return result;
}

async function run(path: string, lines: string[]): Promise<Span[][] | null> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const description = LanguageDescription.matchFilename(languages, name);
    if (!description) return null;
    const support = description.support ?? (await description.load());
    const text = lines.join("\n");
    const starts: number[] = [];
    let pos = 0;
    for (const line of lines) {
        starts.push(pos);
        pos += line.length + 1;
    }
    const out: Span[][] = lines.map(() => []);
    const lineAt = (offset: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid]! <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };
    highlightTree(support.language.parser.parse(text), highlighter, (from, to, classes) => {
        const style = styleOf(classes);
        // A token can run across lines (a block comment): one span per line.
        for (let i = lineAt(from); i < lines.length && from < to; i++) {
            const start = starts[i]!;
            const end = Math.min(to, start + lines[i]!.length);
            if (end > from) out[i]!.push({ from: from - start, to: end - start, style });
            from = start + lines[i]!.length + 1;
        }
    });
    return out;
}

/**
 * Every line's spans in `file`, by line: the old side (context and deletions)
 * and the new side (context and additions) each read as one document, as
 * zeron highlights a diff. Null when the language is unknown or it's too big.
 */
export async function highlightFile(file: FileDiff): Promise<Map<PatchLine, Span[]> | null> {
    if (file.binary || file.lineCount === 0 || file.lineCount > MAX_LINES) return null;
    const oldLines: PatchLine[] = [];
    const newLines: PatchLine[] = [];
    for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
            if (line.kind === "del" || line.kind === "context") oldLines.push(line);
            if (line.kind === "add" || line.kind === "context") newLines.push(line);
        }
    }
    const [oldSpans, newSpans] = await Promise.all([
        oldLines.some((l) => l.kind === "del")
            ? highlightDoc(file.oldPath ?? file.path, oldLines.map((l) => l.text))
            : Promise.resolve(null),
        highlightDoc(file.path, newLines.map((l) => l.text))
    ]);
    if (!oldSpans && !newSpans) return null;
    const spans = new Map<PatchLine, Span[]>();
    oldLines.forEach((line, i) => {
        if (line.kind === "del" && oldSpans) spans.set(line, oldSpans[i]!);
    });
    newLines.forEach((line, i) => {
        if (newSpans) spans.set(line, newSpans[i]!);
    });
    return spans;
}
