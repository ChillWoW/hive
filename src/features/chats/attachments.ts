import { useEffect, useState } from "react";
import type { Attachment } from "@/proto";
import { chatsApi } from "./api";

/** Previews already loaded, by path: an attachment's copy never changes. */
const urls = new Map<string, Promise<string>>();

/** An image (or HTML page) attachment's `data:` URL, once loaded; undefined before (or for other files). */
export function useAttachmentUrl(attachment: Attachment): string | undefined {
    // By path and type: callers may rebuild the same attachment every render.
    const { path, mimeType } = attachment;
    // Images, and the HTML pages agents render.
    const previewable = mimeType.startsWith("image/") || mimeType === "text/html";
    const [url, setUrl] = useState<string>();
    useEffect(() => {
        if (!previewable) return;
        let live = true;
        const key = `${mimeType}:${path}`;
        let pending = urls.get(key);
        if (!pending) {
            pending = chatsApi.attachmentUrl(path, mimeType);
            urls.set(key, pending);
            pending.catch(() => urls.delete(key));
        }
        pending.then((u) => live && setUrl(u)).catch(() => {});
        return () => {
            live = false;
        };
    }, [path, mimeType, previewable]);
    return url;
}

export function isImage(attachment: Attachment): boolean {
    return attachment.mimeType.startsWith("image/");
}

/** `bytes` as base64, in chunks small enough for `String.fromCharCode`. */
function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** A pasted or dropped file, copied for sending. */
export async function attachFile(file: File): Promise<Attachment> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name || (file.type.startsWith("image/") ? `pasted.${file.type.slice(6)}` : "pasted.txt");
    return chatsApi.saveAttachment(name, toBase64(bytes));
}

/** `1234` as `1.2 KB`. */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
