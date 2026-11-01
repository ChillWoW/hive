import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Git changes in the editor's gutter, as VS Code draws them: a green bar on
 * added lines, a blue one on changed lines, a red wedge where lines were
 * removed. Against the file at HEAD (`setGitBase`; null: not in git, or
 * ignored, so nothing is drawn).
 */

/** The file's lines at HEAD (`[""]` for a new file), or null. */
export const setGitBase = StateEffect.define<string[] | null>();
const setChanges = StateEffect.define<RangeSet<GutterMarker>>();

class ChangeMarker extends GutterMarker {
    readonly kind: "added" | "modified" | "deleted" | "deleted-below";
    constructor(kind: ChangeMarker["kind"]) {
        super();
        this.kind = kind;
    }
    override eq(other: GutterMarker) {
        return other instanceof ChangeMarker && other.kind === this.kind;
    }
    override toDOM() {
        const el = document.createElement("div");
        el.className = `cm-git-${this.kind}`;
        return el;
    }
}

const ADDED = new ChangeMarker("added");
const MODIFIED = new ChangeMarker("modified");
const DELETED = new ChangeMarker("deleted");
const DELETED_BELOW = new ChangeMarker("deleted-below");

type Chunk = { fromA: number; toA: number; fromB: number; toB: number };

/** Past this many edits the middle is one changed block. */
const MAX_EDITS = 1500;

/** The changed blocks of `a` → `b` (Myers' diff on whole lines). */
function lineChunks(a: string[], b: string[]): Chunk[] {
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (
        tail < a.length - head &&
        tail < b.length - head &&
        a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
        tail++;
    }
    const n = a.length - head - tail;
    const m = b.length - head - tail;
    if (n === 0 && m === 0) return [];
    const whole = [{ fromA: head, toA: head + n, fromB: head, toB: head + m }];
    if (n === 0 || m === 0) return whole;

    // Lines as numbers, so comparing them is cheap.
    const ids = new Map<string, number>();
    const id = (line: string) => {
        let v = ids.get(line);
        if (v === undefined) ids.set(line, (v = ids.size));
        return v;
    };
    const A = Int32Array.from({ length: n }, (_, i) => id(a[head + i]!));
    const B = Int32Array.from({ length: m }, (_, j) => id(b[head + j]!));

    const max = n + m;
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    // trace[d]: v for k in -d..d before step d, at index k + d.
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= Math.min(max, MAX_EDITS) && !found; d++) {
        trace.push(v.slice(off - d, off + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
            let y = x - k;
            while (x < n && y < m && A[x] === B[y]) {
                x++;
                y++;
            }
            v[off + k] = x;
            if (x >= n && y >= m) {
                found = true;
                break;
            }
        }
    }
    if (!found) return whole;

    // Walk back from the end; the ops come out last first.
    const ops: ("eq" | "del" | "ins")[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const t = trace[d]!;
        const at = (k: number) => t[k + d]!;
        const k = x - y;
        const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
        const prevX = d === 0 ? 0 : at(prevK);
        const prevY = d === 0 ? 0 : prevX - prevK;
        while (x > prevX && y > prevY) {
            ops.push("eq");
            x--;
            y--;
        }
        if (d > 0) ops.push(x === prevX ? "ins" : "del");
        x = prevX;
        y = prevY;
    }

    const chunks: Chunk[] = [];
    let i = head;
    let j = head;
    let open: Chunk | null = null;
    for (let s = ops.length - 1; s >= 0; s--) {
        const op = ops[s]!;
        if (op === "eq") {
            if (open) chunks.push(open);
            open = null;
            i++;
            j++;
            continue;
        }
        open ??= { fromA: i, toA: i, fromB: j, toB: j };
        if (op === "del") open.toA = ++i;
        else open.toB = ++j;
    }
    if (open) chunks.push(open);
    return chunks;
}

function markers(base: string[] | null, doc: Text): RangeSet<GutterMarker> {
    if (!base) return RangeSet.empty;
    const lines = doc.toString().split("\n");
    const builder = new RangeSetBuilder<GutterMarker>();
    for (const c of lineChunks(base, lines)) {
        if (c.fromB === c.toB) {
            // Removed lines: a wedge on the line after them, or under the last.
            if (c.fromB < doc.lines) builder.add(doc.line(c.fromB + 1).from, doc.line(c.fromB + 1).from, DELETED);
            else builder.add(doc.line(doc.lines).from, doc.line(doc.lines).from, DELETED_BELOW);
            continue;
        }
        const marker = c.fromA === c.toA ? ADDED : MODIFIED;
        for (let l = c.fromB; l < c.toB; l++) {
            const from = doc.line(l + 1).from;
            builder.add(from, from, marker);
        }
    }
    return builder.finish();
}

const baseField = StateField.define<string[] | null>({
    create: () => null,
    update(base, tr) {
        for (const e of tr.effects) if (e.is(setGitBase)) base = e.value;
        return base;
    }
});

const changesField = StateField.define<RangeSet<GutterMarker>>({
    create: () => RangeSet.empty,
    update(set, tr) {
        for (const e of tr.effects) {
            if (e.is(setChanges)) return e.value;
            if (e.is(setGitBase)) return markers(e.value, tr.newDoc);
        }
        // Edits are re-diffed a moment later; until then the markers follow.
        return tr.docChanged ? set.map(tr.changes) : set;
    }
});

/** Re-diffs a moment after typing stops (and once on show). */
const rediff = ViewPlugin.fromClass(
    class {
        timer: ReturnType<typeof setTimeout> | undefined;
        readonly view: EditorView;
        constructor(view: EditorView) {
            this.view = view;
            this.schedule(0);
        }
        update(update: ViewUpdate) {
            if (update.docChanged) this.schedule(250);
        }
        schedule(delay: number) {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                const { state } = this.view;
                this.view.dispatch({ effects: setChanges.of(markers(state.field(baseField), state.doc)) });
            }, delay);
        }
        destroy() {
            clearTimeout(this.timer);
        }
    }
);

const theme = EditorView.theme({
    ".cm-git-gutter .cm-gutterElement": { position: "relative", width: "5px" },
    ".cm-git-added, .cm-git-modified": {
        position: "absolute",
        top: "0",
        bottom: "0",
        left: "0",
        width: "3px"
    },
    ".cm-git-added": { backgroundColor: "rgba(52, 211, 153, 0.7)" },
    ".cm-git-modified": { backgroundColor: "rgba(111, 179, 242, 0.75)" },
    ".cm-git-deleted, .cm-git-deleted-below": {
        position: "absolute",
        left: "0",
        width: "0",
        height: "0",
        borderTop: "4px solid transparent",
        borderBottom: "4px solid transparent",
        borderLeft: "5px solid #f87171"
    },
    ".cm-git-deleted": { top: "-4px" },
    ".cm-git-deleted-below": { bottom: "-4px" }
});

export function gitGutter(): Extension {
    return [
        baseField,
        changesField,
        rediff,
        gutter({
            class: "cm-git-gutter",
            markers: (view) => view.state.field(changesField)
        }),
        theme
    ];
}
