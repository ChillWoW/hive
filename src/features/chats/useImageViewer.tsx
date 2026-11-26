import { useState, type ReactNode } from "react";
import type { Attachment } from "@/proto";
import { isImage } from "./attachments";
import { ImageViewer } from "./ImageViewer";

/**
 * A viewer over the images among `attachments`: `open(attachment)` shows that
 * one, and `viewer` must be rendered somewhere (it portals to the body).
 */
export function useImageViewer(attachments: Attachment[]): {
    open: (attachment: Attachment) => void;
    viewer: ReactNode;
} {
    const images = attachments.filter(isImage);
    const [index, setIndex] = useState<number | null>(null);
    return {
        open: (attachment) => {
            const i = images.findIndex((image) => image.path === attachment.path);
            if (i >= 0) setIndex(i);
        },
        viewer: <ImageViewer images={images} index={index} onIndexChange={setIndex} />
    };
}
