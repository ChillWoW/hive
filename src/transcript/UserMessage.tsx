import { Fragment, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
    ArrowClockwiseIcon,
    CaretDownIcon,
    WarningCircleIcon,
    XIcon
} from "@phosphor-icons/react";
import { openAttachment, SavedAttachmentTile } from "@/attachments";
import type { TranscriptMessage } from "@/chats";
import { findPastes, pastesVersion, subscribePastes } from "@/composer/pastes";
import { PasteChip, TagChip } from "@/composer/TagChip";
import { findTags, tagPieces, type FoundTag } from "@/composer/tags";
import { cn } from "@/lib/cn";
import { useResizeObserver } from "@/lib/useResizeObserver";
import { sentCommentRef, splitDiffComments } from "@/review/comments";
import { SentComments } from "@/review/SentComments";
import { promptText } from "./text";

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

/** A sent prompt as text runs, tags and folded pastes (tags inside a paste are its text). */
function promptPieces(text: string) {
    const pastes = findPastes(text);
    const tags = findTags(text, { sent: true }).filter(
        (t) => !pastes.some((p) => p.from < t.to && p.to > t.from)
    );
    const pieces: (ReturnType<typeof tagPieces>[number] | { paste: string })[] = [];
    let last = 0;
    for (const { from, to } of pastes) {
        const before = tags.filter((t) => t.from >= last && t.to <= from);
        pieces.push(...tagPieces(text.slice(last, from), shift(before, -last)));
        pieces.push({ paste: text.slice(from, to) });
        last = to;
    }
    const rest = tags.filter((t) => t.from >= last);
    pieces.push(...tagPieces(text.slice(last), shift(rest, -last)));
    return pieces;
}

const shift = (tags: FoundTag[], by: number) =>
    tags.map((t) => ({ ...t, from: t.from + by, to: t.to + by }));

/** Retry and Discard under a prompt that failed. */
const FAILED_ACTION =
    "inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-dark-200 hover:bg-dark-700 hover:text-dark-50";

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
    // Re-drawn when the known pastes change.
    useSyncExternalStore(subscribePastes, pastesVersion);
    const { prompt: text, comments } = splitDiffComments(promptText(message));
    const delivery = message.delivery;
    const sending = delivery?.state === "sending";
    const attachments = message.attachments ?? [];

    return (
        <div className="flex max-w-[75%] flex-col items-end gap-1 self-end">
            {attachments.length > 0 && (
                <div className={cn("flex flex-wrap justify-end gap-2", sending && "opacity-70")}>
                    {attachments.map((attachment) => (
                        // A click opens it in its default app.
                        <SavedAttachmentTile
                            key={attachment.path}
                            attachment={attachment}
                            size="lg"
                            onOpen={() => void openAttachment(attachment).catch(() => {})}
                        />
                    ))}
                </div>
            )}
            {text.trim() !== "" && (
                <div
                    className={cn(
                        "rounded-2xl rounded-br-md bg-dark-800 px-3 py-1.5 text-sm leading-6 whitespace-pre-wrap break-words text-dark-50",
                        sending && "opacity-70",
                        delivery?.state === "failed" && "ring-1 ring-danger/40"
                    )}
                >
                    <Collapsible>
                        {promptPieces(text).map((piece, i) => {
                            if ("paste" in piece) return <PasteChip key={i} raw={piece.paste} />;
                            if (!("tag" in piece)) return <Fragment key={i}>{piece.text}</Fragment>;
                            const { tag } = piece;
                            if (tag.kind !== "comment") return <TagChip key={i} tag={tag} />;
                            const comment = sentCommentRef(Number(tag.ref), comments);
                            // A `[comment N]` the prompt carries no comment for is just text.
                            if (!comment) return <Fragment key={i}>{piece.raw}</Fragment>;
                            return (
                                <TagChip
                                    key={i}
                                    tag={tag}
                                    comment={{
                                        path: comment.file,
                                        lines: comment.lines,
                                        body: comment.body
                                    }}
                                />
                            );
                        })}
                    </Collapsible>
                </div>
            )}
            {comments.length > 0 && (
                <div className={cn("w-full", sending && "opacity-70")}>
                    <SentComments comments={comments} />
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
                            className={cn("ml-1", FAILED_ACTION)}
                        >
                            <ArrowClockwiseIcon className="size-3" />
                            Retry
                        </button>
                    )}
                    {onDiscard && (
                        <button
                            type="button"
                            onClick={onDiscard}
                            className={FAILED_ACTION}
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
