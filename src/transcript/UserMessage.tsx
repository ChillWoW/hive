import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
    ArrowClockwiseIcon,
    CaretDownIcon,
    WarningCircleIcon,
    XIcon
} from "@phosphor-icons/react";
import { AttachmentTile, openAttachment, useAttachmentUrl } from "@/attachments";
import type { TranscriptMessage } from "@/chats";
import { FileTag, splitMentions } from "@/files";
import { cn } from "@/lib/cn";
import type { Attachment } from "@/proto";

/** A file the user sent; a click opens it in its default app. */
function SentAttachment({ attachment }: { attachment: Attachment }) {
    const url = useAttachmentUrl(attachment);
    return (
        <AttachmentTile
            name={attachment.name}
            imageUrl={url}
            size="lg"
            onOpen={() => void openAttachment(attachment).catch(() => {})}
        />
    );
}

/** Height (px) past which a prompt is collapsed: five lines at `leading-6`. */
const COLLAPSED_HEIGHT = 120;

/** Clips tall content to `COLLAPSED_HEIGHT` with a fade, plus a Show more / less toggle. */
function Collapsible({ children }: { children: ReactNode }) {
    const contentRef = useRef<HTMLDivElement>(null);
    const [overflows, setOverflows] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useLayoutEffect(() => {
        const el = contentRef.current;
        if (!el) return;
        // Some slack so a prompt one line over the limit isn't clipped.
        const measure = () => setOverflows(el.scrollHeight > COLLAPSED_HEIGHT + 24);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

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
                    className="mt-0.5 -ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs text-dark-250 hover:bg-dark-700 hover:text-dark-50"
                >
                    <CaretDownIcon
                        className={cn("size-3 transition-transform", expanded && "rotate-180")}
                    />
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </>
    );
}

/**
 * What the user sent, as a bubble on the right. A prompt the backend hasn't
 * saved yet shows dimmed; one that failed says why, with Retry and Discard.
 * A long prompt is collapsed to five lines until expanded.
 */
export function UserMessage({
    message,
    onRetry,
    onDiscard
}: {
    message: TranscriptMessage;
    onRetry?: () => void;
    onDiscard?: () => void;
}) {
    const text = message.parts
        .flatMap((p) => (p.kind === "text" ? [p.text] : []))
        .join("\n\n");
    const delivery = message.delivery;
    const attachments = message.attachments ?? [];

    return (
        <div className="flex max-w-[75%] flex-col items-end gap-1 self-end">
            {attachments.length > 0 && (
                <div
                    className={cn(
                        "flex flex-wrap justify-end gap-2",
                        delivery?.state === "sending" && "opacity-70"
                    )}
                >
                    {attachments.map((attachment) => (
                        <SentAttachment key={attachment.path} attachment={attachment} />
                    ))}
                </div>
            )}
            {text.trim() !== "" && (
                <div
                    className={cn(
                        "rounded-2xl rounded-br-md bg-dark-800 px-3 py-1.5 text-sm leading-6 whitespace-pre-wrap break-words text-dark-50",
                        delivery?.state === "sending" && "opacity-70",
                        delivery?.state === "failed" && "ring-1 ring-danger/40"
                    )}
                >
                    <Collapsible>
                        {splitMentions(text).map((piece, i) =>
                            "path" in piece ? (
                                <FileTag key={i} path={piece.path} />
                            ) : (
                                <Fragment key={i}>{piece.text}</Fragment>
                            )
                        )}
                    </Collapsible>
                </div>
            )}
            {delivery?.state === "failed" && (
                <div className="flex items-center gap-1 text-xs text-danger">
                    <WarningCircleIcon className="size-3.5 shrink-0" weight="fill" />
                    <span className="min-w-0 truncate" title={delivery.error}>
                        {delivery.error}
                    </span>
                    {onRetry && (
                        <button
                            type="button"
                            onClick={onRetry}
                            className="ml-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-dark-200 hover:bg-dark-700 hover:text-dark-50"
                        >
                            <ArrowClockwiseIcon className="size-3" />
                            Retry
                        </button>
                    )}
                    {onDiscard && (
                        <button
                            type="button"
                            onClick={onDiscard}
                            className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-dark-200 hover:bg-dark-700 hover:text-dark-50"
                        >
                            <XIcon className="size-3" />
                            Discard
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
