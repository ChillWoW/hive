import { useRef, useState, type ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { Message } from "@/proto";
import { AttachmentChip } from "@/features/chats";
import { cn } from "@/lib/cn";
import { useResizeObserver } from "@/lib/useResizeObserver";

/** Height (px) past which a prompt is collapsed: five lines at `leading-6`. */
const COLLAPSED_HEIGHT = 120;

/** Clips tall content to `COLLAPSED_HEIGHT` with a fade, plus a Show more / less toggle. */
function Collapsible({ children }: { children: ReactNode }) {
    const contentRef = useRef<HTMLDivElement>(null);
    const [overflows, setOverflows] = useState(false);
    const [expanded, setExpanded] = useState(false);

    // Some slack so a prompt one line over the limit isn't clipped.
    useResizeObserver(contentRef, (el) => setOverflows(el.scrollHeight > COLLAPSED_HEIGHT + 24));

    const collapsed = overflows && !expanded;
    return (
        <>
            <div
                className="overflow-hidden"
                style={
                    collapsed
                        ? {
                              maxHeight: COLLAPSED_HEIGHT,
                              maskImage: "linear-gradient(to bottom, black 60%, transparent)"
                          }
                        : undefined
                }
            >
                <div ref={contentRef}>{children}</div>
            </div>
            {overflows && (
                <button
                    type="button"
                    onClick={() => setExpanded((e) => !e)}
                    className="mt-0.5 -ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted/85 hover:bg-hover hover:text-text"
                >
                    <CaretDownIcon className={cn("size-3 transition-transform", expanded && "rotate-180")} />
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </>
    );
}

/** What a prompt says: its text parts, a blank line apart. */
function promptText(message: Message): string {
    return message.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("\n\n");
}

/**
 * What the user sent, as a bubble on the right, with the files sent along
 * above it; a long prompt is collapsed to five lines until expanded.
 */
export function UserMessage({ message }: { message: Message }) {
    const text = promptText(message);
    const attachments = message.attachments ?? [];
    if (!text.trim() && attachments.length === 0) return null;
    return (
        <div className="flex max-w-[75%] flex-col items-end gap-1.5 self-end">
            {attachments.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1.5">
                    {attachments.map((attachment) => (
                        <AttachmentChip key={attachment.path} attachment={attachment} />
                    ))}
                </div>
            )}
            {text.trim() && (
                <div className="rounded-2xl rounded-br-md bg-raised px-3 py-1.5 text-sm leading-6 break-words whitespace-pre-wrap text-text">
                    <Collapsible>{text}</Collapsible>
                </div>
            )}
        </div>
    );
}
