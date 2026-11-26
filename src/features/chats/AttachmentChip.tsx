import { XIcon } from "@phosphor-icons/react";
import type { Attachment } from "@/proto";
import { cn } from "@/lib/cn";
import { FileIcon, Tooltip } from "@/ui";
import { formatBytes, useAttachmentUrl } from "./attachments";

/**
 * A file sent (or about to be sent) with a prompt: an image as a thumbnail,
 * anything else as its icon, name and size. `onRemove` adds a remove button.
 */
export function AttachmentChip({
    attachment,
    onRemove,
    className
}: {
    attachment: Attachment;
    onRemove?: () => void;
    className?: string;
}) {
    const url = useAttachmentUrl(attachment);
    const image = attachment.mimeType.startsWith("image/");
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <div
                        className={cn(
                            "group/chip relative flex shrink-0 items-center overflow-hidden rounded-lg border border-border bg-raised",
                            image ? "size-14" : "h-9 max-w-56 gap-2 pr-2.5 pl-2",
                            className
                        )}
                    >
                        {image ? (
                            url ? (
                                <img src={url} alt={attachment.name} className="size-full object-cover" />
                            ) : (
                                <div className="size-full animate-pulse bg-hover" />
                            )
                        ) : (
                            <>
                                <FileIcon name={attachment.name} className="size-4 shrink-0" />
                                <span className="flex min-w-0 flex-col leading-tight">
                                    <span className="truncate text-xs text-text">{attachment.name}</span>
                                    <span className="text-[10px] text-muted/85">{formatBytes(attachment.size)}</span>
                                </span>
                            </>
                        )}
                        {onRemove && (
                            <button
                                type="button"
                                aria-label={`Remove ${attachment.name}`}
                                onClick={onRemove}
                                className={cn(
                                    "absolute top-0.5 right-0.5 inline-flex size-4 items-center justify-center rounded-full",
                                    "bg-black/70 text-white opacity-0 transition-opacity group-hover/chip:opacity-100 focus-visible:opacity-100"
                                )}
                            >
                                <XIcon className="size-2.5" weight="bold" />
                            </button>
                        )}
                    </div>
                }
            />
            <Tooltip.Content side="top">{attachment.name}</Tooltip.Content>
        </Tooltip>
    );
}
