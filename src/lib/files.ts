import { backend } from "./backend";

/** Opens a file in the system's default app for it. */
export function openFile(path: string): Promise<void> {
    return backend("file_open", { path });
}
