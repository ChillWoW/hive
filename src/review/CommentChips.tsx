import { ChatTextIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { openDiffTab } from "@/rightbar/actions";
import { FileIcon, Tooltip } from "@/ui";
import { linesTitle, type DiffComment } from "./comments";

const nameOf = (path: string) => path.slice(path.replace(/\\/g, "/").lastIndexOf("/") + 1);

/** The draft's comments on diff lines, above the composer's field: click shows the diff. */
export function CommentChips({
    comments,
    onRemove
}: {
    comments: DiffComment[];
    onRemove: (id: string) => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
            {comments.map((c) => (
                <Tooltip key={c.id}>
                    <Tooltip.Trigger
                        render={
                            <div
                                className={cn(
                                    "group/chip flex h-7 max-w-64 min-w-0 items-center gap-1.5 rounded-lg border border-dark-700 bg-dark-800 pr-1 pl-2 text-xs",
                                    "transition-colors hover:border-dark-600"
                                )}
                            >
                                <button
                                    type="button"
                                    onClick={openDiffTab}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
                                >
                                    <ChatTextIcon className="size-3.5 shrink-0 text-info" />
                                    <FileIcon name={nameOf(c.path)} className="size-3.5" />
                                    <span className="shrink-0 text-dark-100">
                                        {nameOf(c.path)}
                                        <span className="text-dark-250">
                                            :{linesTitle(c.start, c.end).replace(/^(old )?L/, "$1")}
                                        </span>
                                    </span>
                                    <span className="min-w-0 truncate text-dark-200">{c.body}</span>
                                </button>
                                <button
                                    type="button"
                                    aria-label="Remove comment"
                                    onClick={() => onRemove(c.id)}
                                    className="flex size-5 shrink-0 items-center justify-center rounded-md text-dark-250 hover:bg-dark-700 hover:text-dark-50"
                                >
                                    <XIcon className="size-3" />
                                </button>
                            </div>
                        }
                    />
                    <Tooltip.Content side="top" className="max-w-80">
                        <div className="font-mono text-[11px] text-dark-200">
                            {c.path} · {linesTitle(c.start, c.end)}
                        </div>
                        <div className="mt-0.5 whitespace-pre-wrap">{c.body}</div>
                    </Tooltip.Content>
                </Tooltip>
            ))}
        </div>
    );
}
