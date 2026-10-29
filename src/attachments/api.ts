import { invoke } from "@tauri-apps/api/core";
import type { Attachment } from "@/proto";
import { isTauri } from "@/lib/platform";

/**
 * Attachments (`src-tauri/src/attachments.rs`): Hive copies each file in when
 * it's attached and the prompt carries the copy. Under a plain `bun run dev`
 * there's no backend, so attaching fails.
 */

/** Matches `MAX_ATTACHMENT_BYTES` in `hive-store`. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const NO_BACKEND = "Attachments need the Hive app.";

/** Copies the file in; rejects with the reason it can't be attached. */
export async function saveAttachment(file: File): Promise<Attachment> {
    if (!isTauri) throw new Error(NO_BACKEND);
    if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`${file.name} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return invoke<Attachment>("save_attachment", bytes, {
        headers: { "x-hive-name": encodeURIComponent(file.name) }
    });
}

/** Opens the attachment in its default app. */
export function openAttachment(attachment: Attachment): Promise<void> {
    if (!isTauri) return Promise.reject(new Error(NO_BACKEND));
    return invoke<void>("open_attachment", { path: attachment.path });
}

/** Object URLs of attachments read back, by path; files never change. */
const urls = new Map<string, Promise<string>>();

/** An image attachment as an object URL, read once and kept. */
export function attachmentUrl(attachment: Attachment): Promise<string> {
    let url = urls.get(attachment.path);
    if (!url) {
        url = isTauri
            ? invoke<ArrayBuffer>("attachment_bytes", { path: attachment.path }).then((bytes) =>
                  URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }))
              )
            : Promise.reject(new Error(NO_BACKEND));
        // A failed read can be tried again later.
        url.catch(() => urls.delete(attachment.path));
        urls.set(attachment.path, url);
    }
    return url;
}

/** Seeds the cache with a URL the composer already has for the file. */
export function primeAttachmentUrl(attachment: Attachment, url: string) {
    if (!urls.has(attachment.path)) urls.set(attachment.path, Promise.resolve(url));
}

/** Images the webview can draw. */
export function isImage(mimeType: string) {
    return /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon)$/.test(mimeType);
}
