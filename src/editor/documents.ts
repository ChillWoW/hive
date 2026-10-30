import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
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
import { createJSONStorage, persist } from "zustand/middleware";
import type { FileText } from "@/proto";
import { readFile, writeFile } from "./api";
import { editorTheme } from "./theme";

/** What's wrong with an open file now, as zeron's editor reports it. */
export type DocStatus =
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
    /** Markdown shows rendered, as in zeron, until switched to its code. */
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
        {
            name: "hive.editor",
            storage: createJSONStorage(() => localStorage),
            partialize: (s) => ({ wrap: s.wrap })
        }
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

const MARKDOWN = /\.(md|markdown|mdx)$/i;
export const isMarkdown = (path: string) => MARKDOWN.test(path);

const message = (error: unknown) =>
    error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong.";

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

async function loadLanguage(id: string, path: string) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const description = LanguageDescription.matchFilename(languages, name);
    if (!description) return dispatchTo(id, { effects: language.reconfigure([]) });
    const support = await description.load();
    dispatchTo(id, { effects: language.reconfigure(support) });
}

/** The tab `id`'s file was renamed (moved) to `path`; unsaved changes stay. */
export function moveDoc(id: string, path: string) {
    const doc = getDoc(id);
    if (!doc || doc.path === path) return;
    setDoc(id, { path });
    if (currentState(id)) void loadLanguage(id, path);
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
        if (file.text !== null) {
            const state = EditorState.create({ doc: file.text, extensions: extensions(id, file) });
            states.set(id, state);
            saved.set(id, state.doc);
            void loadLanguage(id, path);
        }
        setDoc(id, { phase: "ready", file });
    } catch (error) {
        setDoc(id, { phase: "error", error: message(error) });
    }
}

/** Forgets the tab `id`'s file (its tab closed). */
export function dropDoc(id: string) {
    views.get(id)?.destroy();
    views.delete(id);
    states.delete(id);
    saved.delete(id);
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
    return view;
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
        setDoc(id, { saving: false, status: { kind: "saveFailed", message: message(error) } });
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
 * Looks at the tab `id`'s file on disk again, as zeron's watcher would: a
 * clean doc takes the new text quietly, a dirty one is marked changed.
 */
export async function checkDisk(id: string) {
    const doc = getDoc(id);
    if (!doc?.file || doc.phase !== "ready" || doc.saving) return;
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
        const state = EditorState.create({ doc: file.text, extensions: extensions(id, file) });
        states.set(id, state);
        saved.set(id, state.doc);
        void loadLanguage(id, now.path);
    }
    applyFromDisk(id, file);
}

/** `checkDisk` for every open file (in `cwd`, when given). */
export function checkAllOnDisk(cwd?: string) {
    for (const [id, doc] of Object.entries(useDocsStore.getState().docs)) {
        if (!cwd || doc.cwd === cwd) void checkDisk(id);
    }
}
