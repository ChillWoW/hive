import { useState } from "react";
import { CaretRightIcon, ChatTextIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { FileIcon } from "@/ui";
import { labelTitle, type SentDiffComment } from "./comments";

const nameOf = (path: string) => path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);

/** The diff comments a prompt carried, under its bubble; each opens to its lines. */
export function SentComments({ comments }: { comments: SentDiffComment[] }) {
    return (
        <div className="flex w-full flex-col items-end gap-1">
            {comments.map((c, i) => (
                <SentComment key={i} comment={c} />
            ))}
        </div>
    );
}

function SentComment({ comment }: { comment: SentDiffComment }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="w-full max-w-md rounded-xl border border-dark-700 bg-dark-850 text-xs">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
                className="flex w-full min-w-0 items-center gap-1.5 px-2.5 pt-1.5 text-left outline-none"
            >
                <ChatTextIcon className="size-3.5 shrink-0 text-info" />
                <FileIcon name={nameOf(comment.file)} className="size-3.5" />
                <span className="min-w-0 truncate text-dark-100" title={comment.file}>
                    {nameOf(comment.file)}
                </span>
                <span className="shrink-0 text-dark-250">{labelTitle(comment.lines)}</span>
                <span className="flex-1" />
                <CaretRightIcon
                    className={cn(
                        "size-3 shrink-0 text-dark-250 transition-transform",
                        open && "rotate-90"
                    )}
                />
            </button>
            {open && (
                <pre className="mx-2.5 mt-1.5 overflow-x-auto rounded-md bg-dark-900 px-2 py-1 font-mono text-[11px] leading-[18px] text-dark-100">
                    {comment.code}
                </pre>
            )}
            <div className="px-2.5 pt-0.5 pb-1.5 leading-5 whitespace-pre-wrap break-words text-dark-50">
                {comment.body}
            </div>
        </div>
    );
}
