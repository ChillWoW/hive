import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
    type RefObject
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { composer, useComposerStore } from "@/composer/store";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import {
    lineRef,
    linesTitle,
    rangeOf,
    refKey,
    sameRef,
    type DiffComment,
    type LineRef
} from "@/review/comments";
import { useSettingsStore } from "@/settings/store";
import { Button, iconButtonClassName, Tooltip } from "@/ui";
import type { FileDiff, PatchLine } from "./patch";

/**
 * Commenting on the diff tab's lines: the gutter's `+` (Shift+click to
 * stretch it over a range) opens a box under the line; a saved comment goes
 * into the open chat's draft (or the new chat's) and rides its next prompt.
 */

/** The comment box that's open: a new comment, or a saved one being edited. */
type Editing = {
    path: string;
    /** Where the first click was; Shift+click stretches from here. */
    anchor: LineRef;
    start: LineRef;
    end: LineRef;
    /** The saved comment it edits. */
    id?: string;
    body: string;
};

type Commenting = {
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

const CommentingContext = createContext<Commenting | null>(null);

export function CommentingProvider({ value, children }: { value: Commenting; children: ReactNode }) {
    return <CommentingContext.Provider value={value}>{children}</CommentingContext.Provider>;
}

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

/** A comment or the box, as wide as the visible column (its scroller is the container). */
export function SlotView({ file, item, sticky }: { file: FileDiff; item: SlotItem; sticky: boolean }) {
    return (
        <div className={cn("px-3 py-1.5", sticky && "sticky left-0 w-[100cqw]")}>
            {item.kind === "comment" ? (
                <CommentCard comment={item.comment} />
            ) : (
                <CommentEditor file={file} editing={item.editing} />
            )}
        </div>
    );
}

/* Split view, unwrapped: the two columns scroll on their own, so the side
   without the item gets a spacer of the item's height to keep rows paired. */
const heights = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
function setHeight(key: string, h: number) {
    if (heights.get(key) === h) return;
    heights.set(key, h);
    listeners.get(key)?.forEach((l) => l());
}

/** The item in its column, its height published for the other column's spacer. */
export function MeasuredSlot({ id, children }: { id: string; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new ResizeObserver(() => setHeight(id, el.offsetHeight));
        observer.observe(el);
        setHeight(id, el.offsetHeight);
        return () => {
            observer.disconnect();
            heights.delete(id);
        };
    }, [id]);
    return <div ref={ref}>{children}</div>;
}

export function SlotSpacer({ id }: { id: string }) {
    const height = useSyncExternalStore(
        (notify) => {
            const set = listeners.get(id) ?? new Set();
            set.add(notify);
            listeners.set(id, set);
            return () => {
                set.delete(notify);
                if (!set.size) listeners.delete(id);
            };
        },
        () => heights.get(id) ?? 0
    );
    return <div aria-hidden="true" style={{ height }} />;
}

function CommentCard({ comment }: { comment: DiffComment }) {
    const ctx = useCommentingContext();
    return (
        <div className="group/comment flex max-w-2xl gap-2 rounded-lg border border-dark-600 bg-dark-800 py-1.5 pr-1.5 pl-3 font-sans">
            <div className="min-w-0 flex-1">
                <div className="text-[11px] text-dark-250">
                    {linesTitle(comment.start, comment.end)} · for the next prompt
                </div>
                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => ctx?.edit(comment)}
                    onKeyDown={(e) => e.key === "Enter" && ctx?.edit(comment)}
                    className="cursor-text text-xs leading-5 whitespace-pre-wrap break-words text-dark-50 outline-none"
                >
                    {comment.body}
                </div>
            </div>
            <div className="flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover/comment:opacity-100 group-focus-within/comment:opacity-100">
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <button
                                type="button"
                                aria-label="Edit comment"
                                onClick={() => ctx?.edit(comment)}
                                className={iconButtonClassName}
                            >
                                <PencilSimpleIcon className="size-3.5" />
                            </button>
                        }
                    />
                    <Tooltip.Content side="top">Edit</Tooltip.Content>
                </Tooltip>
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <button
                                type="button"
                                aria-label="Delete comment"
                                onClick={() => ctx?.remove(comment.id)}
                                className={iconButtonClassName}
                            >
                                <TrashIcon className="size-3.5" />
                            </button>
                        }
                    />
                    <Tooltip.Content side="top">Delete</Tooltip.Content>
                </Tooltip>
            </div>
        </div>
    );
}

function CommentEditor({ file, editing }: { file: FileDiff; editing: Editing }) {
    const ctx = useCommentingContext();
    const [body, setBody] = useState(editing.body);
    const sendWith = useSettingsStore((s) => s.settings.keyboard.sendWith);
    const field = useRef<HTMLTextAreaElement>(null);
    // A range stretched by Shift+click moves the box; it keeps the caret.
    useEffect(() => {
        const el = field.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
    }, [editing]);
    useEffect(() => {
        if (ctx) ctx.body.current = body;
    }, [ctx, body]);
    if (!ctx) return null;
    const submit = () => {
        ctx.body.current = body;
        ctx.save(file);
    };
    return (
        <div className="max-w-2xl rounded-lg border border-info/40 bg-dark-800 p-1.5 font-sans">
            <TextareaAutosize
                ref={field}
                value={body}
                minRows={2}
                maxRows={12}
                placeholder={`Comment on ${linesTitle(editing.start, editing.end)}`}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        ctx.cancel();
                        return;
                    }
                    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                    const mod = isMac ? e.metaKey : e.ctrlKey;
                    if (sendWith === "mod-enter" && !mod) return;
                    e.preventDefault();
                    submit();
                }}
                className="block w-full resize-none bg-transparent px-1.5 py-1 text-xs leading-5 text-dark-50 outline-none placeholder:text-dark-250"
            />
            <div className="flex items-center gap-1.5 pt-1 pl-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-dark-250">
                    {editing.id ? "" : "Shift+click another line for a range · "}Goes with your next prompt
                </span>
                <Button size="sm" variant="ghost" onClick={ctx.cancel}>
                    Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={submit}>
                    {editing.id ? "Save" : "Comment"}
                </Button>
            </div>
        </div>
    );
}
