import { Chunk } from "@codemirror/merge";
import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";

/**
 * Change marks beside the line numbers: each line that differs from the
 * file's committed text (`setGitBase`) gets a bar (added or modified), and
 * a notch shows where lines were removed. They follow the text as it's typed.
 */

/** The committed text to compare with; null for none (no marks). */
export const setGitBase = StateEffect.define<Text | null>();

/** Gives up on a precise diff of texts that differ a lot, so typing never waits on it. */
const DIFF = { scanLimit: 500, timeout: 200 };

class Mark extends GutterMarker {
    constructor(cls: string) {
        super();
        this.elementClass = cls;
    }
    eq(other: Mark) {
        return other.elementClass === this.elementClass;
    }
}

const ADDED = new Mark("cm-gitAdded");
const MODIFIED = new Mark("cm-gitModified");
/** Lines are gone from above this one. */
const DELETED = new Mark("cm-gitDeleted");
/** Lines are gone from below this one (the text's last). */
const DELETED_BELOW = new Mark("cm-gitDeletedBelow");

type Marks = RangeSet<GutterMarker>;

function marksOf(chunks: readonly Chunk[], doc: Text): Marks {
    const builder = new RangeSetBuilder<GutterMarker>();
    for (const chunk of chunks) {
        if (chunk.fromB === chunk.toB) {
            if (chunk.fromB > doc.length) builder.add(doc.lineAt(doc.length).from, doc.lineAt(doc.length).from, DELETED_BELOW);
            else builder.add(chunk.fromB, chunk.fromB, DELETED);
            continue;
        }
        const mark = chunk.fromA === chunk.toA ? ADDED : MODIFIED;
        const last = doc.lineAt(Math.min(chunk.endB, doc.length)).number;
        for (let n = doc.lineAt(chunk.fromB).number; n <= last; n++) {
            const from = doc.line(n).from;
            builder.add(from, from, mark);
        }
    }
    return builder.finish();
}

type Value = { base: Text | null; chunks: readonly Chunk[]; marks: Marks };

const NONE: Value = { base: null, chunks: [], marks: RangeSet.empty };

const field = StateField.define<Value>({
    create: () => NONE,
    update(value, tr) {
        let { base, chunks } = value;
        let replaced = false;
        for (const effect of tr.effects) {
            if (!effect.is(setGitBase)) continue;
            const same = effect.value && base ? effect.value.eq(base) : effect.value === base;
            if (same) continue;
            base = effect.value;
            replaced = true;
        }
        if (!base) return replaced ? NONE : value;
        if (replaced) chunks = Chunk.build(base, tr.newDoc, DIFF);
        else if (tr.docChanged) chunks = Chunk.updateB(chunks, base, tr.newDoc, tr.changes, DIFF);
        else return value;
        return { base, chunks, marks: marksOf(chunks, tr.newDoc) };
    }
});

/** A notch pointing at the seam the lines were removed from. */
const notch = (edge: "top" | "bottom") => ({
    content: '""',
    position: "absolute",
    left: "0",
    [edge]: "-4px",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--danger)"
});

const theme = EditorView.baseTheme({
    ".cm-gitGutter": { width: "5px" },
    ".cm-gitGutter .cm-gutterElement": { position: "relative" },
    ".cm-gitAdded": { borderLeft: "3px solid var(--success)" },
    ".cm-gitModified": { borderLeft: "3px solid var(--warning)" },
    ".cm-gitDeleted::before": notch("top"),
    ".cm-gitDeletedBelow::before": notch("bottom")
});

/** The marks' gutter; put it after the line numbers'. */
export const gitGutter: Extension = [
    field,
    gutter({ class: "cm-gitGutter", markers: (view) => view.state.field(field).marks }),
    theme
];
