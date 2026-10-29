import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri } from "@/lib/platform";

/**
 * Transport for app updates (`src-tauri/src/updater.rs`). Under a plain
 * `bun run dev` a made-up update shows up so the button can be tried out;
 * installing it plays a fake download and then fails.
 */

export type UpdateInfo = {
    version: string;
    currentVersion: string;
    notes?: string | null;
};

export type UpdateProgress =
    | { kind: "downloading"; downloaded: number; total?: number | null }
    | { kind: "installing" };

/** The newer release, or null when up to date (always null in dev builds). */
export function checkForUpdate(): Promise<UpdateInfo | null> {
    if (!isTauri) {
        return Promise.resolve({ version: "0.0.2", currentVersion: "0.0.1", notes: null });
    }
    return invoke<UpdateInfo | null>("update_check");
}

/**
 * Downloads and installs the update the last check found, stopping every
 * agent and terminal first; Hive then restarts. Resolves only if it didn't.
 */
export function installUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
    if (!isTauri) return fakeInstall(onProgress);
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    return invoke("update_install", { onProgress: channel });
}

async function fakeInstall(onProgress: (progress: UpdateProgress) => void) {
    const total = 12_000_000;
    for (let downloaded = 0; downloaded <= total; downloaded += total / 20) {
        onProgress({ kind: "downloading", downloaded, total });
        await new Promise((r) => setTimeout(r, 120));
    }
    onProgress({ kind: "installing" });
    await new Promise((r) => setTimeout(r, 1500));
    throw new Error("Updates need the desktop app.");
}
