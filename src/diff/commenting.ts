import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type RefObject
} from "react";
import { composer, useComposerStore } from "@/composer/store";
import {
    lineRef,
    rangeOf,
    refKey,
    sameRef,
    type DiffComment,
    type LineRef
} from "@/review/comments";
import type { FileDiff, PatchLine } from "./patch";

/**
 * Commenting on the diff tab's lines: the gutter's `+` (Shift+click to
 * stretch it over a range) opens a box under the line; a saved comment goes
 * into the open chat's draft (or the new chat's) and rides its next prompt.
 */

/** The comment box that's open: a new comment, or a saved one being edited. */
export type Editing = {
    path: string;
    /** Where the first click was; Shift+click stretches from here. */
    anchor: LineRef;
    start: LineRef;
    end: LineRef;
    /** The saved comment it edits. */
    id?: string;
    body: string;
};

export type Commenting = {
    /** The draft's comments on this checkout's files. */
    comments: DiffComment[];
    editing: Editing | null;
    /** The open box's text as typed. */
    body: RefObject<string>;
    begin: (file: FileDiff, line: PatchLine, extend: boolean) => void;
    edit: (comment: DiffComment) => void;
    cancel: () => void;
    /** Saves the box's text (empty deletes an edited comment). */
    save: (file: FileDiff) => void;
    remove: (id: string) => void;
};

export const CommentingContext = createContext<Commenting | null>(null);

const NO_COMMENTS: DiffComment[] = [];

/** The diff tab's commenting, on the draft of `chatId` (null: the new chat's). */
export function useCommenting(
    chatId: string | null,
    folder: string | null,
    root: string | undefined
): Commenting | null {
    const all = useComposerStore((s) => s.comments[chatId ?? s.newDraftId] ?? NO_COMMENTS);
    const comments = useMemo(
        () => (root ? all.filter((c) => c.root === root) : NO_COMMENTS),
        [all, root]
    );
    const [editing, setEditing] = useState<Editing | null>(null);
    /** The open box's text, kept here (not in state) so typing re-renders nothing else. */
    const body = useRef("");
    // Another chat's draft, another box.
    useEffect(() => setEditing(null), [chatId, root]);

    const begin = useCallback((file: FileDiff, line: PatchLine, extend: boolean) => {
        const ref = lineRef(line);
        if (!ref) return;
        setEditing((open) => {
            if (extend && open && open.path === file.path && !open.id) {
                const range = rangeOf(file, open.anchor, ref);
                if (range) return { ...open, start: range[0], end: range[1], body: body.current };
            }
            // A new comment's unsaved text moves with the box.
            const text = open && !open.id ? body.current : "";
            return { path: file.path, anchor: ref, start: ref, end: ref, body: text };
        });
    }, []);
    const edit = useCallback(
        (c: DiffComment) =>
            setEditing({
                path: c.path,
                anchor: c.start,
                start: c.start,
                end: c.end,
                id: c.id,
                body: c.body
            }),
        []
    );
    const cancel = useCallback(() => setEditing(null), []);
    const save = useCallback(
        (file: FileDiff) => {
            const open = editing;
            setEditing(null);
            if (!open || !root || !folder) return;
            const text = body.current.trim();
            if (!text) {
                if (open.id) composer.removeComment(chatId, open.id);
                return;
            }
            const range = rangeOf(file, open.start, open.end);
            const saved = open.id ? comments.find((c) => c.id === open.id) : undefined;
            composer.putComment(chatId, {
                id: open.id ?? crypto.randomUUID(),
                root,
                folder,
                path: file.path,
                start: open.start,
                end: open.end,
                code: range?.[2] ?? saved?.code ?? "",
                body: text
            });
        },
        [chatId, folder, root, comments, editing]
    );
    const remove = useCallback((id: string) => composer.removeComment(chatId, id), [chatId]);

    return useMemo(
        () =>
            root && folder
                ? { comments, editing, body, begin, edit, cancel, save, remove }
                : null,
        [root, folder, comments, editing, begin, edit, cancel, save, remove]
    );
}

export const useCommentingContext = () => useContext(CommentingContext);

/** What sits under a line: comments ending on it, and the box if it ends there. */
export type SlotItem =
    | { key: string; kind: "comment"; side: LineRef["side"]; comment: DiffComment }
    | { key: string; kind: "editor"; side: LineRef["side"]; editing: Editing };

/** A file's comment slots by the line they sit under, and the box's lines. */
export function useFileSlots(file: FileDiff) {
    const ctx = useCommentingContext();
    return useMemo(() => {
        if (!ctx) return null;
        const slots = new Map<string, SlotItem[]>();
        const push = (ref: LineRef, item: SlotItem) => {
            const key = refKey(ref);
            slots.set(key, [...(slots.get(key) ?? []), item]);
        };
        for (const c of ctx.comments) {
            if (c.path !== file.path || (ctx.editing?.id === c.id)) continue;
            push(c.end, { key: c.id, kind: "comment", side: c.end.side, comment: c });
        }
        const editing = ctx.editing?.path === file.path ? ctx.editing : null;
        let picked: Set<string> | null = null;
        if (editing) {
            push(editing.end, { key: "editor", kind: "editor", side: editing.end.side, editing });
            picked = new Set();
            const lines = file.hunks.flatMap((h) => h.lines);
            let inside = false;
            for (const line of lines) {
                const r = lineRef(line);
                if (!r) continue;
                if (sameRef(r, editing.start)) inside = true;
                if (inside) picked.add(refKey(r));
                if (sameRef(r, editing.end)) break;
            }
        }
        return { slots, picked, begin: ctx.begin };
    }, [ctx, file]);
}

export type FileSlots = NonNullable<ReturnType<typeof useFileSlots>>;

/** The items under `lines` (a split row's two sides), each once. */
export function itemsAfter(slots: FileSlots | null, lines: (PatchLine | undefined)[]): SlotItem[] {
    if (!slots) return [];
    const keys = new Set<string>();
    for (const line of lines) {
        const r = line && lineRef(line);
        if (r) keys.add(refKey(r));
    }
    return [...keys].flatMap((k) => slots.slots.get(k) ?? []);
}
