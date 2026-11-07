import { useState } from "react";
import { ArrowSquareOutIcon, ArrowsOutSimpleIcon } from "@phosphor-icons/react";
import type { Attachment } from "@/proto";
import { openAttachment } from "@/attachments";
import { useAttachmentUrl } from "@/attachments/useAttachmentUrl";
import { cn } from "@/lib/cn";
import { IconButton, Modal } from "@/ui";
import type { ImageRef } from "./tools";

/**
 * An image Hive's `show_image` / `show_svg` tool showed, inline in the
 * transcript where the call was: at its own size, scaled down to fit. On
 * hover: its name, Open (default app) and Full screen; a click opens it full
 * screen too. Drawn as an `<img>`, so an SVG's scripts never run.
 */
export function ShownImage({ image }: { image: ImageRef }) {
    const attachment: Attachment = { path: image.file, name: image.name, mimeType: image.mimeType, size: 0 };
    const url = useAttachmentUrl(attachment);
    const [fullScreen, setFullScreen] = useState(false);
    const title = image.caption ?? image.name;

    return (
        <figure className="group/image relative flex flex-col items-start gap-1.5">
            <button
                type="button"
                aria-label={`Show ${title} full screen`}
                onClick={() => setFullScreen(true)}
                className={cn(
                    "max-w-full cursor-zoom-in overflow-hidden rounded-md",
                    image.light && "bg-white p-3"
                )}
            >
                {url ? (
                    <img
                        src={url}
                        alt={title}
                        draggable={false}
                        className="block max-h-160 max-w-full object-contain"
                    />
                ) : (
                    <div className="h-40 w-64" />
                )}
            </button>
            {image.caption && <figcaption className="text-xs text-dark-250">{image.caption}</figcaption>}
            <div className="absolute -top-3 right-0 flex items-center gap-0.5 rounded-md border border-dark-600 bg-dark-850 py-0.5 pr-0.5 pl-2 opacity-0 shadow-md shadow-black/30 transition-opacity group-hover/image:opacity-100 focus-within:opacity-100">
                <span className="mr-1 max-w-56 truncate text-[11.5px] text-dark-200">{image.name}</span>
                <IconButton label="Open" onClick={() => void openAttachment(attachment)}>
                    <ArrowSquareOutIcon className="size-3.5" />
                </IconButton>
                <IconButton label="Full screen" onClick={() => setFullScreen(true)}>
                    <ArrowsOutSimpleIcon className="size-3.5" />
                </IconButton>
            </div>
            {url && (
                <Modal
                    open={fullScreen}
                    onOpenChange={setFullScreen}
                    title={title}
                    className="w-[92%] max-w-none"
                    bodyClassName="flex h-[calc(86vh-6rem)] items-center justify-center"
                >
                    <img
                        src={url}
                        alt={title}
                        className={cn(
                            "size-full object-contain",
                            image.light && "rounded-md bg-white p-4"
                        )}
                    />
                </Modal>
            )}
        </figure>
    );
}
