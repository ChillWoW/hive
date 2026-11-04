import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
    Compartment,
    EditorState,
    Text,
    Transaction,
    type Extension,
    type TransactionSpec
} from "@codemirror/state";
import {
    drawSelection,
    dropCursor,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    rectangularSelection
} from "@codemirror/view";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { errorMessage } from "@/lib/errors";
import type { FileText } from "@/proto";
import { headText, readFile, writeFile } from "./api";
import { gitGutter, setGitBase } from "./gitGutter";
import { languageOf } from "./language";
import { editorTheme } from "./theme";

/** What's wrong with an open file now. */
type DocStatus =
    | { kind: "saveFailed"; message: string }
    /** A save found the file changed since it was read. */
    | { kind: "conflict" }
    /** It changed on disk while it had unsaved changes. */
    | { kind: "changed" }
    | { kind: "deleted" };

/** An open file, by its tab's id. Its text lives in CodeMirror (`currentState`). */
export type Doc = {
    cwd: string;
    path: string;
    phase: "loading" | "ready" | "error";
    error?: string;
    /** The last read or save: hash, line ending, read-only reason… */
    file?: FileText;
    dirty: boolean;
    saving: boolean;
    status: DocStatus | null;
    /** Its tab was asked to close, but the save before it failed. */
    closeBlocked: boolean;
    /** Markdown shows rendered until switched to its code. */
    preview: boolean;
    /** Bumped when the text is replaced from disk, so previews re-read it. */
    version: number;
};

export const useDocsStore = create<{ docs: Record<string, Doc> }>()(() => ({ docs: {} }));

/** Editor preferences, kept on this device. */
export const useEditorPrefs = create<{ wrap: boolean; toggleWrap: () => void }>()(
    persist(
        (set) => ({
            wrap: false,
            toggleWrap: () => {
                set((s) => ({ wrap: !s.wrap }));
                const wrap = useEditorPrefs.getState().wrap;
                for (const id of Object.keys(useDocsStore.getState().docs)) {
                    dispatchTo(id, { effects: wrapping.reconfigure(wrapExtension(wrap)) });
                }
            }
        }),
        { name: "hive.editor", partialize: (s) => ({ wrap: s.wrap }) }
    )
);

const language = new Compartment();
const wrapping = new Compartment();
const editability = new Compartment();

/** Each doc's state while its tab isn't on screen. */
const states = new Map<string, EditorState>();
/** The editor of the tab on screen. */
const views = new Map<string, EditorView>();
/** What's on disk, as last read or saved: the doc is dirty when it differs. */
const saved = new Map<string, Text>();
/** A line to show once the doc is read (`revealLine` before it was). */
const pendingReveal = new Map<string, LinePosition>();
/** Docs whose cursor should be scrolled into view when their editor is next shown. */
const scrollOnAttach = new Set<string>();
/** Each doc's last HEAD text handed to its gutter (null: not tracked). */
const gitBases = new Map<string, string | null>();

/**
 * A 1-based line and, optionally, column (UTF-16 units); `length` selects
 * that many units from there (within the line).
 */
export type LinePosition = { line: number; column?: number; length?: number };

const MARKDOWN = /\.(md|markdown|mdx)$/i;
export const isMarkdown = (path: string) => MARKDOWN.test(path);

const getDoc = (id: string) => useDocsStore.getState().docs[id];

function setDoc(id: string, patch: Partial<Doc> | ((doc: Doc) => Partial<Doc>)) {
    useDocsStore.setState((s) => {
        const doc = s.docs[id];
        if (!doc) return s;
        const next = typeof patch === "function" ? patch(doc) : patch;
        return { docs: { ...s.docs, [id]: { ...doc, ...next } } };
    });
}

export const currentState = (id: string) => views.get(id)?.state ?? states.get(id);

function dispatchTo(id: string, spec: TransactionSpec) {
    const view = views.get(id);
    if (view) return view.dispatch(spec);
    const state = states.get(id);
    if (state) {
        const next = state.update(spec).state;
        states.set(id, next);
        noteChange(id, next);
    }
}

function noteChange(id: string, state: EditorState) {
    const base = saved.get(id);
    const dirty = !!base && !state.doc.eq(base);
    if (getDoc(id)?.dirty !== dirty) setDoc(id, { dirty });
}

const wrapExtension = (wrap: boolean) => (wrap ? EditorView.lineWrapping : []);
const editableExtension = (editable: boolean) => [
    EditorState.readOnly.of(!editable),
    EditorView.editable.of(editable)
];

function extensions(id: string, file: FileText): Extension[] {
    return [
        lineNumbers(),
        gitGutter(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
            {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                    void save(id);
                    return true;
                }
            },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab
        ]),
        language.of([]),
        wrapping.of(wrapExtension(useEditorPrefs.getState().wrap)),
        editability.of(editableExtension(!file.readOnly)),
        editorTheme,
        EditorView.updateListener.of((update) => {
            if (update.docChanged) noteChange(id, update.state);
        })
    ];
}

/**
 * Starts the tab `id`'s editor state on `text` (as what's on disk), then
 * loads its language and its gutter's HEAD text.
 */
function startEditor(id: string, file: FileText, text: string, path: string) {
    const state = EditorState.create({ doc: text, extensions: extensions(id, file) });
    states.set(id, state);
    saved.set(id, state.doc);
    gitBases.delete(id);
    void loadLanguage(id, path);
    void refreshGitBase(id);
}

/** Reads the doc's file at HEAD again for its gutter's change markers. */
async function refreshGitBase(id: string) {
    const doc = getDoc(id);
    if (!doc) return;
    let text: string | null = null;
    try {
        text = await headText(doc.cwd, doc.path);
    } catch {
        // Not shown: no git, or the file went.
    }
    if (getDoc(id)?.path !== doc.path || !currentState(id)) return;
    if (gitBases.has(id) && gitBases.get(id) === text) return;
    gitBases.set(id, text);
    dispatchTo(id, { effects: setGitBase.of(text === null ? null : text.split("\n")) });
}

async function loadLanguage(id: string, path: string) {
    const support = await languageOf(path);
    dispatchTo(id, { effects: language.reconfigure(support ?? []) });
}

/** The tab `id`'s file was renamed (moved) to `path`; unsaved changes stay. */
export function moveDoc(id: string, path: string) {
    const doc = getDoc(id);
    if (!doc || doc.path === path) return;
    setDoc(id, { path });
    if (currentState(id)) {
        void loadLanguage(id, path);
        void refreshGitBase(id);
    }
}

/** Reads `path` for the tab `id`, once. */
export async function openDoc(id: string, cwd: string, path: string) {
    if (getDoc(id)) return;
    useDocsStore.setState((s) => ({
        docs: {
            ...s.docs,
            [id]: {
                cwd,
                path,
                phase: "loading",
                dirty: false,
                saving: false,
                status: null,
                closeBlocked: false,
                preview: isMarkdown(path),
                version: 0
            }
        }
    }));
    try {
        const file = await readFile(cwd, path);
        if (!getDoc(id)) return;
        if (file.text !== null) startEditor(id, file, file.text, path);
        setDoc(id, { phase: "ready", file });
        const at = pendingReveal.get(id);
        pendingReveal.delete(id);
        if (at) revealLine(id, at);
    } catch (error) {
        setDoc(id, { phase: "error", error: errorMessage(error, "Something went wrong.") });
    }
}

/** Forgets the tab `id`'s file (its tab closed). */
export function dropDoc(id: string) {
    views.get(id)?.destroy();
    views.delete(id);
    states.delete(id);
    saved.delete(id);
    pendingReveal.delete(id);
    scrollOnAttach.delete(id);
    gitBases.delete(id);
    useDocsStore.setState((s) => {
        const { [id]: _, ...docs } = s.docs;
        return { docs };
    });
}

/** Shows the tab `id`'s editor in `parent`; `detachView` puts it away again. */
export function attachView(id: string, parent: HTMLElement) {
    const state = states.get(id);
    if (!state || views.has(id)) return null;
    const view = new EditorView({ state, parent });
    views.set(id, view);
    // Next frame, once it's laid out; and only if it's still the one shown
    // (StrictMode attaches, detaches and attaches again).
    if (scrollOnAttach.has(id)) {
        requestAnimationFrame(() => {
            if (views.get(id) !== view || !scrollOnAttach.delete(id)) return;
            scrollToSelection(view);
        });
    }
    return view;
}

function scrollToSelection(view: EditorView) {
    view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.from, { y: "center" })
    });
    view.focus();
}

/**
 * Puts the tab `id`'s cursor on `at` and scrolls it into view (once the file
 * is read, if it isn't yet); a Markdown file leaves its preview for the code.
 */
export function revealLine(id: string, at: LinePosition) {
    const state = currentState(id);
    if (!state) {
        if (getDoc(id)?.phase === "loading") pendingReveal.set(id, at);
        return;
    }
    const line = state.doc.line(Math.min(Math.max(Math.floor(at.line), 1), state.doc.lines));
    const pos = Math.min(line.from + Math.max((at.column ?? 1) - 1, 0), line.to);
    const selection = { anchor: pos, head: Math.min(pos + Math.max(at.length ?? 0, 0), line.to) };
    if (getDoc(id)?.preview) setDoc(id, { preview: false });
    const view = views.get(id);
    if (view) {
        view.dispatch({ selection });
        scrollToSelection(view);
        // Again once a panel that was just shown has its size.
        requestAnimationFrame(() => {
            if (views.get(id) === view) scrollToSelection(view);
        });
    } else {
        dispatchTo(id, { selection });
        scrollOnAttach.add(id);
    }
}

export function detachView(id: string, view: EditorView) {
    if (views.get(id) !== view) return;
    states.set(id, view.state);
    views.delete(id);
    view.destroy();
}

export const togglePreview = (id: string) => setDoc(id, (doc) => ({ preview: !doc.preview }));

/** Its tab's close waits on a save that failed. */
export const blockClose = (id: string) => setDoc(id, { closeBlocked: true });
export const unblockClose = (id: string) => setDoc(id, { closeBlocked: false });

/**
 * Saves the tab `id`'s text over its file, named by the hash it was read
 * with; true once written. Edits made meanwhile stay unsaved.
 */
export async function save(id: string): Promise<boolean> {
    const doc = getDoc(id);
    const state = currentState(id);
    if (!doc?.file || !state || doc.saving || doc.file.readOnly) return false;
    // A conflict, a change on disk or a deletion is settled first.
    if (doc.status && doc.status.kind !== "saveFailed") return false;
    const text = state.doc;
    setDoc(id, { saving: true });
    try {
        const outcome = await writeFile(
            doc.cwd,
            doc.path,
            text.toString(),
            doc.file.hash,
            doc.file.lineEnding,
            doc.file.bom
        );
        if (outcome.kind === "written") {
            saved.set(id, text);
            const now = currentState(id);
            setDoc(id, (d) => ({
                saving: false,
                status: null,
                file: d.file && { ...d.file, hash: outcome.hash },
                dirty: !!now && !now.doc.eq(text)
            }));
            return true;
        }
        setDoc(id, { saving: false, status: { kind: outcome.deleted ? "deleted" : "conflict" } });
    } catch (error) {
        setDoc(id, {
            saving: false,
            status: { kind: "saveFailed", message: errorMessage(error, "Something went wrong.") }
        });
    }
    return false;
}

/** Replaces the doc's text with what's on disk, keeping the caret where it can. */
function replaceText(id: string, file: FileText) {
    const state = currentState(id);
    if (!state || file.text === null) return;
    const next = file.text;
    const old = state.doc.toString();
    // Only the changed middle, so the selection outside it stays put.
    let start = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    let end = 0;
    while (
        end < old.length - start &&
        end < next.length - start &&
        old[old.length - 1 - end] === next[next.length - 1 - end]
    ) {
        end++;
    }
    saved.set(id, Text.of(next.split("\n")));
    dispatchTo(id, {
        changes: { from: start, to: old.length - end, insert: next.slice(start, next.length - end) },
        effects: editability.reconfigure(editableExtension(!file.readOnly)),
        // Not something to undo.
        annotations: Transaction.addToHistory.of(false)
    });
}

function applyFromDisk(id: string, file: FileText) {
    replaceText(id, file);
    setDoc(id, (doc) => ({
        file,
        status: null,
        closeBlocked: false,
        dirty: false,
        version: doc.version + 1
    }));
}

/** Throws away unsaved changes for what's on disk now. */
export async function reloadFromDisk(id: string) {
    const doc = getDoc(id);
    if (!doc) return;
    try {
        applyFromDisk(id, await readFile(doc.cwd, doc.path));
    } catch {
        setDoc(id, { status: { kind: "deleted" } });
    }
}

/** Saves over a file that changed on disk since it was read. */
export async function overwrite(id: string) {
    const doc = getDoc(id);
    if (!doc?.file) return;
    try {
        const disk = await readFile(doc.cwd, doc.path);
        setDoc(id, (d) => ({ status: null, file: d.file && { ...d.file, hash: disk.hash } }));
        await save(id);
    } catch {
        setDoc(id, { status: { kind: "deleted" } });
    }
}

/**
 * Looks at the tab `id`'s file on disk again, as a watcher would: a clean
 * doc takes the new text quietly, a dirty one is marked changed.
 */
export async function checkDisk(id: string) {
    const doc = getDoc(id);
    if (!doc?.file || doc.phase !== "ready" || doc.saving) return;
    // HEAD may have moved (a commit, a branch switch) even when the file didn't.
    void refreshGitBase(id);
    let file: FileText;
    try {
        file = await readFile(doc.cwd, doc.path);
    } catch {
        setDoc(id, { status: { kind: "deleted" } });
        return;
    }
    const now = getDoc(id);
    if (!now?.file || now.saving) return;
    if (file.hash === now.file.hash) {
        // Back as it was (e.g. a deleted file restored).
        if (now.status?.kind === "deleted" || now.status?.kind === "changed") {
            setDoc(id, { status: null });
        }
        return;
    }
    if (now.dirty) {
        if (now.status?.kind !== "conflict") setDoc(id, { status: { kind: "changed" } });
        return;
    }
    if (file.text !== null && !states.has(id) && !views.has(id)) {
        // It was unreadable before and is text now: start an editor for it.
        startEditor(id, file, file.text, now.path);
    }
    applyFromDisk(id, file);
}

/** `checkDisk` for every open file (in `cwd`, when given). */
export function checkAllOnDisk(cwd?: string) {
    for (const [id, doc] of Object.entries(useDocsStore.getState().docs)) {
        if (!cwd || doc.cwd === cwd) void checkDisk(id);
    }
}
