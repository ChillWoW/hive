import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
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
import { TagFace } from "./TagChip";
import { findTags, type FoundTag, type Tag } from "./tags";

/** Rows the field grows to before it scrolls. */
const MAX_ROWS = 12;
const LINE_HEIGHT = 24;

/*
 * The text stays plain (what the drafts store holds and what's sent), with
 * `@path`, `$skill` and a leading `/command` drawn as tags — atomic, so the
 * caret steps over one and Backspace takes it whole.
 *
 * A tag is made when its text comes in from outside (a draft loaded, a menu
 * pick), pasted, or typed out and followed by a space; while it's being
 * typed it stays text, so the `@` and `/` menus keep working on it. A tag
 * whose text is changed goes back to text.
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
/** A change made from outside (the drafts store): not echoed back. */
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
            if (pasted ? f.from >= fromB && f.to <= toB : /^\s/.test(text) && f.to === fromB) made.push(f);
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
            next = next.update({ filter: (from, to, tag) => to > from && doc.slice(from, to) === tag.raw });
        }
        const add: FoundTag[] = [];
        for (const effect of tr.effects) if (effect.is(addTags)) add.push(...effect.value);
        if (doc !== null) add.push(...typedTags(tr, doc));
        const fresh = untagged(next, add).filter((f, i, all) => all.findIndex((g) => g.from === f.from) === i);
        if (fresh.length) {
            next = next.update({ add: tagRanges(doc ?? tr.state.doc.toString(), fresh), sort: true });
        }
        return next;
    }
});

class TagWidget extends WidgetType {
    readonly tag: Tag;
    constructor(tag: Tag) {
        super();
        this.tag = tag;
    }
    override eq(other: TagWidget): boolean {
        return JSON.stringify(this.tag) === JSON.stringify(other.tag);
    }
    toDOM(): HTMLElement {
        const span = document.createElement("span");
        span.className = "cm-tag";
        span.innerHTML = renderToStaticMarkup(<TagFace tag={this.tag} />);
        return span;
    }
    override ignoreEvent(): boolean {
        return false;
    }
}

const tagDecorations = EditorView.decorations.compute([tagsField], (state): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    for (const iter = state.field(tagsField).iter(); iter.value; iter.next()) {
        builder.add(iter.from, iter.to, Decoration.replace({ widget: new TagWidget(iter.value.tag) }));
    }
    return builder.finish();
});

const theme = EditorView.theme({
    "&": { color: "inherit", backgroundColor: "transparent", fontSize: "inherit" },
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
    ".cm-placeholder": { color: "color-mix(in srgb, var(--color-muted) 75%, transparent)" }
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
    /** Takes focus; `"end"` puts the caret after the text. */
    focus: (at?: "end") => void;
    /**
     * Replaces the text (as the smallest change from what's there), the caret
     * at `caret` (its end by default). Tags are made in what changed, except
     * a token ending at the caret with no space after it: still being typed.
     */
    setText: (text: string, caret?: number) => void;
};

type PromptFieldProps = {
    ref?: Ref<PromptFieldHandle>;
    value: string;
    /** A new key starts over: the text from `value`, no undo history. */
    resetKey: string;
    placeholder?: string;
    onChange: (text: string) => void;
    onFocusChange?: (focused: boolean) => void;
    /** The caret moved (typing, clicks, arrows, `setText`). */
    onCaretChange?: (caret: number) => void;
    /** The tags as they now are. */
    onTags?: (tags: FoundTag[]) => void;
    /** Runs before the field's own keys; true takes the key. */
    onKeyDown?: (event: KeyboardEvent, view: EditorView) => boolean;
    /** True when the paste was taken (files). */
    onPaste?: (event: ClipboardEvent) => boolean;
    /** A drag carrying files: left to the composer. */
    carriesFiles?: (event: DragEvent) => boolean;
    className?: string;
};

/**
 * The composer's text field (CodeMirror): grows with what's typed up to
 * `MAX_ROWS`, then scrolls; `@path`, `$skill` and a leading `/command` show
 * as tags.
 */
export function PromptField(props: PromptFieldProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const placeholderRef = useRef(new Compartment());

    const createState = (text: string) =>
        EditorState.create({
            doc: text,
            selection: EditorSelection.cursor(text.length),
            extensions: [
                tagsField,
                tagDecorations,
                EditorView.atomicRanges.of((view) => view.state.field(tagsField)),
                EditorView.lineWrapping,
                EditorView.contentAttributes.of({ "aria-label": "Message", spellcheck: "false" }),
                history(),
                Prec.highest(
                    EditorView.domEventHandlers({
                        keydown: (event, view) => {
                            if (!propsRef.current.onKeyDown?.(event, view)) return false;
                            event.preventDefault();
                            return true;
                        },
                        paste: (event) => propsRef.current.onPaste?.(event) ?? false,
                        // Files dropped are attachments, never text.
                        dragover: (event) => propsRef.current.carriesFiles?.(event) ?? false,
                        drop: (event) => propsRef.current.carriesFiles?.(event) ?? false
                    })
                ),
                Prec.high(keymap.of([{ key: "Enter", run: insertNewline, shift: insertNewline }])),
                keymap.of([...standardKeymap, ...historyKeymap]),
                placeholderRef.current.of(
                    propsRef.current.placeholder ? placeholderText(propsRef.current.placeholder) : []
                ),
                theme,
                EditorView.updateListener.of((update) => {
                    const p = propsRef.current;
                    const outside = update.transactions.some((tr) => tr.annotation(external));
                    if (update.docChanged && !outside) p.onChange(update.state.doc.toString());
                    if (update.docChanged || update.selectionSet) p.onCaretChange?.(update.state.selection.main.head);
                    if (update.focusChanged) p.onFocusChange?.(update.view.hasFocus);
                    if (update.startState.field(tagsField) !== update.state.field(tagsField)) {
                        p.onTags?.(tagsOf(update.state));
                    }
                })
            ]
        });

    useEffect(() => {
        const view = new EditorView({ state: createState(propsRef.current.value), parent: hostRef.current! });
        viewRef.current = view;
        propsRef.current.onTags?.(tagsOf(view.state));
        return () => {
            view.destroy();
            viewRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Another draft: its text, its own undo history.
    const keyRef = useRef(props.resetKey);
    useEffect(() => {
        if (keyRef.current === props.resetKey) return;
        keyRef.current = props.resetKey;
        const view = viewRef.current;
        if (!view) return;
        const focused = view.hasFocus;
        view.setState(createState(propsRef.current.value));
        if (focused) view.focus();
        propsRef.current.onTags?.(tagsOf(view.state));
        propsRef.current.onCaretChange?.(view.state.selection.main.head);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.resetKey]);

    const replace = (text: string, caret: number | undefined, outside: boolean) => {
        const view = viewRef.current;
        if (!view) return;
        const old = view.state.doc.toString();
        if (old === text && caret === undefined) return;
        let start = 0;
        const max = Math.min(old.length, text.length);
        while (start < max && old[start] === text[start]) start++;
        let end = 0;
        while (end < max - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
        const insertEnd = text.length - end;
        const made = findTags(text).filter(
            (f) => f.from <= insertEnd && f.to >= start && !(f.to === caret && !/\s/.test(text[f.to] ?? ""))
        );
        view.dispatch({
            changes: { from: start, to: old.length - end, insert: text.slice(start, insertEnd) },
            selection: caret === undefined ? undefined : EditorSelection.cursor(Math.min(caret, text.length)),
            effects: addTags.of(made),
            annotations: outside ? external.of(true) : undefined,
            scrollIntoView: caret !== undefined
        });
    };

    useImperativeHandle(props.ref, () => ({
        get dom() {
            return hostRef.current;
        },
        get view() {
            return viewRef.current;
        },
        focus: (at) => {
            const view = viewRef.current;
            if (!view) return;
            view.focus();
            if (at === "end") view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
        },
        setText: (text, caret = text.length) => replace(text, caret, false)
    }));

    // The drafts store changed under the field.
    useEffect(() => {
        const view = viewRef.current;
        if (view && view.state.doc.toString() !== props.value) replace(props.value, undefined, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.value]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: placeholderRef.current.reconfigure(props.placeholder ? placeholderText(props.placeholder) : [])
        });
    }, [props.placeholder]);

    return <div ref={hostRef} className={props.className} />;
}
