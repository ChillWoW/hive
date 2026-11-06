import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    Annotation,
    Compartment,
    EditorSelection,
    EditorState,
    Prec,
    RangeSet,
    RangeSetBuilder,
    RangeValue,
    StateEffect,
    StateField,
    type Transaction
} from "@codemirror/state";
import {
    Decoration,
    EditorView,
    WidgetType,
    keymap,
    placeholder as placeholderText,
    type DecorationSet
} from "@codemirror/view";
import { history, historyKeymap, insertNewline, standardKeymap } from "@codemirror/commands";
import { commentTokens } from "@/review/comments";
import { PasteFace, TagFace, type TagComment } from "./TagChip";
import { findTags, type FoundTag, type Tag } from "./tags";
import {
    findPastes,
    forgetPaste,
    isBigPaste,
    rememberPaste,
    type Span
} from "./pastes";

/** Rows the field grows to before it scrolls. */
const MAX_ROWS = 12;
const LINE_HEIGHT = 24;

/**
 * The composer's text field: plain text (what the drafts store holds and
 * what's sent), with `@path`, `$skill`, a leading `/command` and diff
 * comment tokens drawn as tags — atomic, so the caret steps over one and
 * Backspace takes it whole.
 *
 * A tag is made when its text comes in from outside (a draft loaded, a menu
 * pick, a file added from the tree), pasted, or typed out and followed by a
 * space; while it's being typed it stays text, so the `@` / `/` / `$` menus
 * keep working on it. Comment tokens are always tags. A tag whose text is
 * changed (or that's no longer one there) goes back to text.
 */

class TagValue extends RangeValue {
    // Text typed at either edge goes outside the tag.
    override startSide = 1;
    override endSide = -1;
    readonly tag: Tag;
    readonly raw: string;
    constructor(tag: Tag, raw: string) {
        super();
        this.tag = tag;
        this.raw = raw;
    }
    override eq(other: RangeValue): boolean {
        return other instanceof TagValue && other.raw === this.raw;
    }
}

const addTags = StateEffect.define<FoundTag[]>();
const setComments = StateEffect.define<ReadonlyMap<string, TagComment>>();
/** A change made from outside (the drafts store, a menu): not echoed back. */
const external = Annotation.define<boolean>();

const tagRanges = (doc: string, found: FoundTag[]) =>
    found.map((f) => new TagValue(f.tag, doc.slice(f.from, f.to)).range(f.from, f.to));

/** Tags `found` lists that no tag there already covers. */
function untagged(set: RangeSet<TagValue>, found: FoundTag[]): FoundTag[] {
    return found.filter((f) => {
        let covered = false;
        set.between(f.from, f.to, (from, to) => {
            if (from < f.to && to > f.from) covered = true;
        });
        return !covered;
    });
}

/** The tags a user edit makes: what was pasted, and a token typed out to a space. */
function typedTags(tr: Transaction, doc: string): FoundTag[] {
    if (!tr.isUserEvent("input")) return [];
    const found = findTags(doc);
    const made: FoundTag[] = [];
    const pasted = tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop");
    tr.changes.iterChanges((_fa, _ta, fromB, toB, inserted) => {
        const text = inserted.toString();
        for (const f of found) {
            if (pasted ? f.from >= fromB && f.to <= toB : /^\s/.test(text) && f.to === fromB) {
                made.push(f);
            }
        }
    });
    return made;
}

const tagsField = StateField.define<RangeSet<TagValue>>({
    create: (state) => {
        const doc = state.doc.toString();
        return RangeSet.of(tagRanges(doc, findTags(doc)), true);
    },
    update(value, tr) {
        let next = value.map(tr.changes);
        const doc = tr.docChanged ? tr.newDoc.toString() : null;
        if (doc !== null) {
            next = next.update({
                filter: (from, to, tag) => to > from && doc.slice(from, to) === tag.raw
            });
        }
        const text = doc ?? tr.state.doc.toString();
        const add: FoundTag[] = [];
        for (const effect of tr.effects) if (effect.is(addTags)) add.push(...effect.value);
        if (doc !== null) {
            add.push(...typedTags(tr, doc));
            // Comment tokens never show as text.
            add.push(...findTags(doc).filter((f) => f.tag.kind === "comment"));
        }
        const fresh = untagged(next, add).filter(
            (f, i, all) => all.findIndex((g) => g.from === f.from) === i
        );
        if (fresh.length) next = next.update({ add: tagRanges(text, fresh), sort: true });
        return next;
    }
});

/**
 * Big pastes, folded to a chip. Only drawn that way: the text stays in the
 * draft and is sent as is. Atomic like a tag (Backspace takes it whole); a
 * click unfolds it. Folded pastes are remembered (`pastes.ts`), so a draft
 * that comes back (another chat, a queued prompt edited, history, a reload)
 * folds them again, and the sent prompt shows them the same way.
 */
class PasteValue extends RangeValue {
    override startSide = 1;
    override endSide = -1;
    readonly raw: string;
    constructor(raw: string) {
        super();
        this.raw = raw;
    }
    override eq(other: RangeValue): boolean {
        return other instanceof PasteValue && other.raw === this.raw;
    }
}

const addPastes = StateEffect.define<Span[]>();
/** Unfolds the paste starting there. */
const unfoldPaste = StateEffect.define<number>();

const pasteRanges = (doc: string, spans: Span[]) =>
    spans
        .toSorted((a, b) => a.from - b.from)
        .map((s) => new PasteValue(doc.slice(s.from, s.to)).range(s.from, s.to));

const pastesField = StateField.define<RangeSet<PasteValue>>({
    create: (state) => {
        const doc = state.doc.toString();
        return RangeSet.of(pasteRanges(doc, findPastes(doc)));
    },
    update(value, tr) {
        let next = value.map(tr.changes);
        const doc = tr.docChanged ? tr.newDoc.toString() : null;
        const unfold = tr.effects.filter((e) => e.is(unfoldPaste)).map((e) => e.value);
        if (doc !== null || unfold.length) {
            next = next.update({
                filter: (from, to, paste) =>
                    to > from &&
                    !unfold.includes(from) &&
                    (doc === null || doc.slice(from, to) === paste.raw)
            });
        }
        const add: Span[] = [];
        for (const effect of tr.effects) if (effect.is(addPastes)) add.push(...effect.value);
        if (tr.isUserEvent("input.paste")) {
            tr.changes.iterChanges((_fa, _ta, from, to, inserted) => {
                if (isBigPaste(inserted.toString())) add.push({ from, to });
            });
        }
        const fresh = add.filter((s) => {
            let covered = false;
            next.between(s.from, s.to, (from, to) => {
                if (from < s.to && to > s.from) covered = true;
            });
            return !covered;
        });
        if (fresh.length) {
            next = next.update({
                add: pasteRanges(doc ?? tr.state.doc.toString(), fresh),
                sort: true
            });
        }
        return next;
    }
});

class PasteWidget extends WidgetType {
    readonly raw: string;
    constructor(raw: string) {
        super();
        this.raw = raw;
    }
    override eq(other: PasteWidget): boolean {
        return other.raw === this.raw;
    }
    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.className = "cm-tag";
        span.innerHTML = renderToStaticMarkup(<PasteFace raw={this.raw} />);
        span.addEventListener("mousedown", (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            forgetPaste(this.raw);
            const at = view.posAtDOM(span);
            view.dispatch({ effects: unfoldPaste.of(at), selection: EditorSelection.cursor(at) });
            view.focus();
        });
        return span;
    }
    override ignoreEvent(event: Event): boolean {
        return event.type === "mousedown";
    }
}

const pasteDecorations = EditorView.decorations.compute([pastesField], (state): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const iter = state.field(pastesField).iter(); iter.value; iter.next()) {
        builder.add(
            iter.from,
            iter.to,
            Decoration.replace({ widget: new PasteWidget(iter.value.raw) })
        );
    }
    return builder.finish();
});

/** Whether `from`–`to` lies inside a folded paste. */
function inPaste(state: EditorState, from: number, to: number): boolean {
    let inside = false;
    state.field(pastesField).between(from, to, (pFrom, pTo) => {
        if (pFrom <= from && pTo >= to) inside = true;
    });
    return inside;
}

const commentsField = StateField.define<ReadonlyMap<string, TagComment>>({
    create: () => new Map(),
    update(value, tr) {
        for (const effect of tr.effects) if (effect.is(setComments)) return effect.value;
        return value;
    }
});

class TagWidget extends WidgetType {
    readonly tag: Tag;
    readonly comment: TagComment | undefined;
    constructor(tag: Tag, comment: TagComment | undefined) {
        super();
        this.tag = tag;
        this.comment = comment;
    }
    override eq(other: TagWidget): boolean {
        return (
            JSON.stringify([this.tag, this.comment]) === JSON.stringify([other.tag, other.comment])
        );
    }
    toDOM(): HTMLElement {
        const span = document.createElement("span");
        span.className = "cm-tag";
        span.innerHTML = renderToStaticMarkup(<TagFace tag={this.tag} comment={this.comment} />);
        return span;
    }
    override ignoreEvent(): boolean {
        return false;
    }
}

const tagDecorations = EditorView.decorations.compute(
    [tagsField, commentsField, pastesField],
    (state): DecorationSet => {
        const comments = state.field(commentsField);
        const builder = new RangeSetBuilder<Decoration>();
        for (const iter = state.field(tagsField).iter(); iter.value; iter.next()) {
            // The paste's chip covers it.
            if (inPaste(state, iter.from, iter.to)) continue;
            const { tag } = iter.value;
            const comment = tag.kind === "comment" ? comments.get(tag.ref) : undefined;
            builder.add(iter.from, iter.to, Decoration.replace({ widget: new TagWidget(tag, comment) }));
        }
        return builder.finish();
    }
);

const theme = EditorView.theme({
    "&": { color: "inherit", backgroundColor: "transparent", fontSize: "14px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: `${LINE_HEIGHT}px`,
        maxHeight: `${MAX_ROWS * LINE_HEIGHT + 8}px`,
        // Lines wrap; else WebKit can show a horizontal scrollbar.
        overflowX: "hidden",
        overflowY: "auto",
        overscrollBehavior: "contain"
    },
    ".cm-content": { padding: "4px 0", caretColor: "currentColor" },
    ".cm-line": { padding: "0" },
    ".cm-placeholder": { color: "var(--color-dark-250)" }
});

/** The tags in `state`, in order. */
function tagsOf(state: EditorState): FoundTag[] {
    const found: FoundTag[] = [];
    for (const iter = state.field(tagsField).iter(); iter.value; iter.next()) {
        found.push({ from: iter.from, to: iter.to, tag: iter.value.tag });
    }
    return found;
}

export type PromptFieldHandle = {
    /** The element the field is laid out in. */
    dom: HTMLDivElement | null;
    view: EditorView | null;
    focus: (caret?: "end") => void;
    /**
     * Sets the text (as the smallest change from what's there), the caret at
     * `caret`. Tags are made in what changed — except a token ending at
     * `open` with no space after it, still being completed.
     */
    setText: (text: string, options?: { caret?: number; open?: number }) => void;
};

type PromptFieldProps = {
    value: string;
    /** A new key starts over: the text from `value`, no undo history. */
    resetKey: string;
    placeholder?: string;
    /** What each comment tag shows, by comment id. */
    comments: ReadonlyMap<string, TagComment>;
    className?: string;
    onChange: (text: string) => void;
    onCaret: (caret: number) => void;
    onFocusChange: (focused: boolean) => void;
    /** The tags as they now are. */
    onTags: (tags: FoundTag[]) => void;
    /** Comment tags the user deleted. */
    onCommentsRemoved: (ids: string[]) => void;
    /** Runs before the field's own keys; true takes the key. */
    onKeyDown: (event: KeyboardEvent, view: EditorView) => boolean;
    /** True when the paste was taken (files). */
    onPaste: (event: ClipboardEvent) => boolean;
    /** A drag carrying files: left to the composer. */
    carriesFiles: (event: DragEvent) => boolean;
};

export const PromptField = forwardRef<PromptFieldHandle, PromptFieldProps>(
    function PromptField(props, ref) {
        const hostRef = useRef<HTMLDivElement>(null);
        const viewRef = useRef<EditorView | null>(null);
        const propsRef = useRef(props);
        propsRef.current = props;
        const placeholderRef = useRef(new Compartment());

        const createState = (text: string) =>
            EditorState.create({
                doc: text,
                extensions: [
                    tagsField,
                    commentsField.init(() => propsRef.current.comments),
                    pastesField,
                    tagDecorations,
                    pasteDecorations,
                    EditorView.atomicRanges.of((view) => view.state.field(tagsField)),
                    EditorView.atomicRanges.of((view) => view.state.field(pastesField)),
                    EditorView.lineWrapping,
                    EditorView.contentAttributes.of({ "aria-label": "Message" }),
                    history(),
                    Prec.highest(
                        EditorView.domEventHandlers({
                            keydown: (event, view) => propsRef.current.onKeyDown(event, view),
                            paste: (event) => propsRef.current.onPaste(event),
                            // Files dropped are attachments, never text.
                            dragover: (event) => propsRef.current.carriesFiles(event),
                            drop: (event) => propsRef.current.carriesFiles(event)
                        })
                    ),
                    Prec.high(keymap.of([{ key: "Enter", run: insertNewline, shift: insertNewline }])),
                    keymap.of([...standardKeymap, ...historyKeymap]),
                    placeholderRef.current.of(
                        propsRef.current.placeholder
                            ? placeholderText(propsRef.current.placeholder)
                            : []
                    ),
                    theme,
                    EditorView.updateListener.of((update) => {
                        const p = propsRef.current;
                        const outside = update.transactions.some((tr) => tr.annotation(external));
                        if (update.docChanged && !outside) {
                            const doc = update.state.doc.toString();
                            p.onChange(doc);
                            const kept = new Set(commentTokens(doc).map((t) => t.id));
                            const removed = commentTokens(update.startState.doc.toString())
                                .map((t) => t.id)
                                .filter((id) => !kept.has(id));
                            if (removed.length) p.onCommentsRemoved(removed);
                        }
                        if (update.docChanged || update.selectionSet) {
                            p.onCaret(update.state.selection.main.head);
                        }
                        if (update.focusChanged) p.onFocusChange(update.view.hasFocus);
                        const pastes = update.state.field(pastesField);
                        if (update.startState.field(pastesField) !== pastes) {
                            for (const iter = pastes.iter(); iter.value; iter.next()) {
                                rememberPaste(iter.value.raw);
                            }
                        }
                        if (update.startState.field(tagsField) !== update.state.field(tagsField)) {
                            p.onTags(tagsOf(update.state));
                        }
                    })
                ]
            });

        useEffect(() => {
            const view = new EditorView({
                state: createState(propsRef.current.value),
                parent: hostRef.current!
            });
            viewRef.current = view;
            propsRef.current.onTags(tagsOf(view.state));
            return () => {
                view.destroy();
                viewRef.current = null;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // Another draft: its text, its own undo history.
        const firstKey = useRef(true);
        useEffect(() => {
            if (firstKey.current) {
                firstKey.current = false;
                return;
            }
            const view = viewRef.current;
            if (!view) return;
            const focused = view.hasFocus;
            view.setState(createState(propsRef.current.value));
            if (focused) view.focus();
            propsRef.current.onTags(tagsOf(view.state));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [props.resetKey]);

        const setText: PromptFieldHandle["setText"] = (text, options = {}) => {
            const view = viewRef.current;
            if (!view) return;
            const old = view.state.doc.toString();
            if (old === text && options.caret === undefined) return;
            let start = 0;
            const max = Math.min(old.length, text.length);
            while (start < max && old[start] === text[start]) start++;
            let end = 0;
            while (
                end < max - start &&
                old[old.length - 1 - end] === text[text.length - 1 - end]
            ) {
                end++;
            }
            const insertEnd = text.length - end;
            const made = findTags(text).filter(
                (f) =>
                    f.from <= insertEnd &&
                    f.to >= start &&
                    !(f.to === options.open && !/\s/.test(text[f.to] ?? ""))
            );
            view.dispatch({
                changes: { from: start, to: old.length - end, insert: text.slice(start, insertEnd) },
                selection:
                    options.caret === undefined
                        ? undefined
                        : EditorSelection.cursor(Math.min(options.caret, text.length)),
                effects: [addTags.of(made), addPastes.of(findPastes(text))],
                annotations: external.of(true),
                scrollIntoView: options.caret !== undefined
            });
        };

        useImperativeHandle(ref, () => ({
            get dom() {
                return hostRef.current;
            },
            get view() {
                return viewRef.current;
            },
            focus: (caret) => {
                const view = viewRef.current;
                if (!view) return;
                view.focus();
                if (caret === "end") {
                    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
                }
            },
            setText
        }));

        // The drafts store changed under the field (a file added from the
        // tree, a comment from the diff, a queued prompt taken back).
        useEffect(() => {
            const view = viewRef.current;
            if (view && view.state.doc.toString() !== props.value) setText(props.value);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [props.value]);

        useEffect(() => {
            viewRef.current?.dispatch({ effects: setComments.of(props.comments) });
        }, [props.comments]);

        useEffect(() => {
            viewRef.current?.dispatch({
                effects: placeholderRef.current.reconfigure(
                    props.placeholder ? placeholderText(props.placeholder) : []
                )
            });
        }, [props.placeholder]);

        return <div ref={hostRef} className={props.className} />;
    }
);
