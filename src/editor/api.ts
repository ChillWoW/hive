import type { FileText, LineEnding, WriteOutcome } from "@/proto";
import { backend } from "@/lib/backend";
import { FAKE_TEXT } from "@/files/api";

/** Files of the made-up project under plain `bun run dev`, by path. */
const fake = new Map<string, string>();
const fakeText = (path: string) =>
    fake.get(path) ??
    FAKE_TEXT[path] ??
    `// ${path}\n// A made-up file: there's no backend under plain \`bun run dev\`.\n`;
/** Good enough to tell versions apart in the fake. */
const fakeHash = (text: string) => `${text.length}:${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)}`;

/** `path` (relative to `cwd`) for the editor (`src-tauri/src/editor.rs`). */
export function readFile(cwd: string, path: string): Promise<FileText> {
    return backend<FileText>("read_file", { cwd, path }, () => {
        const text = fakeText(path);
        return {
            text,
            hash: fakeHash(text),
            size: text.length,
            lineEnding: "lf",
            bom: false,
            readOnly: null
        };
    });
}

/**
 * `path`'s text at HEAD for the gutter's change markers: `""` for a new file,
 * null when git doesn't track it. A made-up older version under `bun run dev`.
 */
export function headText(cwd: string, path: string): Promise<string | null> {
    return backend<string | null>(
        "git_head_text",
        { cwd, path },
        () => `// ${path}\n// An older line.\n`
    );
}

/** A file's bytes as an object URL (an image preview). */
export async function fileObjectUrl(cwd: string, path: string, mimeType: string) {
    const bytes = await backend<ArrayBuffer>("read_file_bytes", { cwd, path });
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
    return backend<WriteOutcome>(
        "write_file",
        { cwd, path, text, expectedHash, lineEnding, bom },
        () => {
            if (fakeHash(fakeText(path)) !== expectedHash) return { kind: "conflict", deleted: false };
            fake.set(path, text);
            return { kind: "written", hash: fakeHash(text) };
        }
    );
}

/** Opens a file in its default app. */
export function openFile(cwd: string, path: string): Promise<void> {
    return backend("open_file", { cwd, path });
}
