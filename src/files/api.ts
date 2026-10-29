import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceEntry } from "@/proto";
import { isTauri } from "@/lib/platform";

/** A made-up project for plain `bun run dev`, where there's no backend. */
const FAKE: WorkspaceEntry[] = [
    "src/",
    "src/chat/",
    "src/composer/",
    "src-tauri/",
    "README.md",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
    "src/App.tsx",
    "src/main.tsx",
    "src/index.css",
    "src/chat/ChatView.tsx",
    "src/composer/Composer.tsx",
    "src/composer/store.ts",
    "src-tauri/Cargo.toml",
    "src-tauri/src/lib.rs"
].map((path) => ({ path: path.replace(/\/$/, ""), dir: path.endsWith("/") }));

/**
 * Every file and folder under `cwd` that `.gitignore` doesn't hide,
 * shallowest first (`src-tauri/src/files.rs`).
 */
export function listFiles(cwd: string): Promise<WorkspaceEntry[]> {
    if (!isTauri) return Promise.resolve(FAKE);
    return invoke<WorkspaceEntry[]>("list_files", { cwd });
}
