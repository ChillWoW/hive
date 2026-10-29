import { invoke } from "@tauri-apps/api/core";
import type { FileText, LineEnding, WriteOutcome } from "@/proto";
import { isTauri } from "@/lib/platform";

/** Files of the made-up project under plain `bun run dev`, by path. */
const fake = new Map<string, string>();
const fakeText = (path: string) =>
    fake.get(path) ?? `// ${path}\n// A made-up file: there's no backend under plain \`bun run dev\`.\n`;
/** Good enough to tell versions apart in the fake. */
const fakeHash = (text: string) => `${text.length}:${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)}`;

/** `path` (relative to `cwd`) for the editor (`src-tauri/src/editor.rs`). */
export function readFile(cwd: string, path: string): Promise<FileText> {
    if (isTauri) return invoke<FileText>("read_file", { cwd, path });
    const text = fakeText(path);
    return Promise.resolve({
        text,
        hash: fakeHash(text),
        size: text.length,
        lineEnding: "lf",
        bom: false,
        readOnly: null
    });
}

/** A file's bytes as an object URL (an image preview). */
export async function fileObjectUrl(cwd: string, path: string, mimeType: string) {
    if (!isTauri) throw new Error("No backend under plain `bun run dev`.");
    const bytes = await invoke<ArrayBuffer>("read_file_bytes", { cwd, path });
    return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/** Saves `text`, unless the file no longer has `expectedHash`. */
export function writeFile(
    cwd: string,
    path: string,
    text: string,
    expectedHash: string,
    lineEnding: LineEnding,
    bom: boolean
): Promise<WriteOutcome> {
    if (isTauri) {
        return invoke<WriteOutcome>("write_file", {
            cwd,
            path,
            text,
            expectedHash,
            lineEnding,
            bom
        });
    }
    if (fakeHash(fakeText(path)) !== expectedHash) {
        return Promise.resolve({ kind: "conflict", deleted: false });
    }
    fake.set(path, text);
    return Promise.resolve({ kind: "written", hash: fakeHash(text) });
}

/** Opens a file in its default app. */
export function openFile(cwd: string, path: string): Promise<void> {
    if (!isTauri) return Promise.reject(new Error("No backend under plain `bun run dev`."));
    return invoke("open_file", { cwd, path });
}
