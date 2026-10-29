import { useEffect, useState } from "react";
import type { Attachment } from "@/proto";
import { attachmentUrl, isImage } from "./api";

/** An image attachment's URL once read; undefined meanwhile and for other files. */
export function useAttachmentUrl(attachment: Attachment): string | undefined {
    const image = isImage(attachment.mimeType);
    const [url, setUrl] = useState<{ path: string; url: string }>();

    useEffect(() => {
        if (!image) return;
        let live = true;
        attachmentUrl(attachment)
            .then((next) => live && setUrl({ path: attachment.path, url: next }))
            .catch(() => {});
        return () => {
            live = false;
        };
        // The file at a path never changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [image, attachment.path]);

    return url?.path === attachment.path ? url.url : undefined;
}
