import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { DotMatrixSpinner, Tooltip } from "@/ui";
import { FileChip } from "./FileChip";

type AttachmentTileProps = {
    name: string;
    mimeType: string;
    /** An image's URL; without one the file is drawn as a `FileChip`. */
    imageUrl?: string;
    /** Still being copied in, or that failed (with why). */
    uploading?: boolean;
    error?: string;
    /** The composer's: a remove button on the tile's corner. */
    onRemove?: () => void;
    /** The transcript's: the tile opens the file. */
    onOpen?: () => void;
    /** Thumbnail size; the transcript's are larger. */
    size?: "sm" | "lg";
};

/**
 * One attached file: images as thumbnails, anything else as a `FileChip`.
 * In the composer it has a remove button and shows its upload; in the
 * transcript a click opens it. As in Desktop/agent.
 */
export function AttachmentTile({
    name,
    mimeType,
    imageUrl,
    uploading,
    error,
    onRemove,
    onOpen,
    size = "sm"
}: AttachmentTileProps) {
    const remove = onRemove && (
        <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
            // Straddles the corner, outside the tile, so it covers neither a
            // thumbnail nor a file's name.
            className={cn(
                "absolute -top-1.5 -right-1.5 z-1 flex size-5 items-center justify-center rounded-full",
                "border border-dark-600 bg-dark-800 text-dark-200 opacity-0 outline-none",
                "transition-[opacity,color] duration-150",
                "group-hover/attachment:opacity-100 hover:text-dark-50 focus-visible:opacity-100",
                error && "opacity-100"
            )}
        >
            <XIcon className="size-2.5" weight="bold" />
        </button>
    );

    const status = uploading ? (
        <span className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-dark-900/60 text-dark-100">
            <DotMatrixSpinner label={`Attaching ${name}`} />
        </span>
    ) : error ? (
        <span className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-dark-900/70 text-danger">
            <WarningCircleIcon className="size-4" weight="fill" />
        </span>
    ) : null;

    const body = imageUrl ? (
        <div
            className={cn(
                "group/attachment relative shrink-0 rounded-xl",
                size === "lg" ? "size-24" : "size-14"
            )}
        >
            <img
                src={imageUrl}
                alt={name}
                draggable={false}
                className={cn(
                    "size-full rounded-xl border border-dark-600 object-cover",
                    error && "border-danger/60"
                )}
            />
            {status}
            {remove}
        </div>
    ) : (
        <FileChip
            name={name}
            mimeType={mimeType}
            className={cn("group/attachment", error && "border-danger/60")}
        >
            {status}
            {remove}
        </FileChip>
    );

    const tile = onOpen ? (
        <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${name}`}
            className="min-w-0 cursor-pointer rounded-xl outline-none transition-opacity hover:opacity-85 focus-visible:ring-1 focus-visible:ring-dark-400"
        >
            {body}
        </button>
    ) : (
        body
    );

    if (!error && !(onOpen && imageUrl)) return tile;
    return (
        <Tooltip>
            <Tooltip.Trigger render={<span className="inline-flex min-w-0">{tile}</span>} />
            <Tooltip.Content side="top">{error ?? name}</Tooltip.Content>
        </Tooltip>
    );
}
