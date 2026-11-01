import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { isMac } from "@/lib/platform";
import { useResizeObserver } from "@/lib/useResizeObserver";
import { linesTitle, type DiffComment } from "@/review/comments";
import { useSettingsStore } from "@/settings/store";
import { Button, IconButton } from "@/ui";
import {
    CommentingContext,
    useCommentingContext,
    type Commenting,
    type Editing,
    type SlotItem
} from "./commenting";
import type { FileDiff } from "./patch";

/** Makes the lines under it commentable; with a null `value`, not. */
export function CommentingProvider({
    value,
    children
}: {
    value: Commenting | null;
    children: ReactNode;
}) {
    return <CommentingContext.Provider value={value}>{children}</CommentingContext.Provider>;
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
    useResizeObserver(ref, (el) => setHeight(id, el.offsetHeight));
    useLayoutEffect(
        () => () => {
            heights.delete(id);
        },
        [id]
    );
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
                <IconButton
                    label="Edit comment"
                    tooltip="Edit"
                    side="top"
                    onClick={() => ctx?.edit(comment)}
                >
                    <PencilSimpleIcon className="size-3.5" />
                </IconButton>
                <IconButton
                    label="Delete comment"
                    tooltip="Delete"
                    side="top"
                    onClick={() => ctx?.remove(comment.id)}
                >
                    <TrashIcon className="size-3.5" />
                </IconButton>
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
