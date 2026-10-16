/**
 * False under a plain `bun run dev`, where the page is served to a browser and no
 * Tauri APIs exist. Anything that would `invoke` has to check this first, or it
 * throws on a workflow the project documents as supported.
 */
export const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type Platform = "macos" | "windows" | "linux";

/**
 * Detected from the webview UA rather than `@tauri-apps/plugin-os` so it stays
 * synchronous (no first-paint flash of the wrong labels) and needs no plugin.
 * Keyboard shortcuts are the first thing that cares: `mod` means Command on one
 * of these and Control on the other two, and the answer is needed to draw a
 * shortcut, not just to match one.
 */
function detectPlatform(): Platform {
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    if (/mac|iphone|ipad|ipod/i.test(ua)) return "macos";
    if (/win/i.test(ua)) return "windows";
    return "linux";
}

export const platform = detectPlatform();
export const isMac = platform === "macos";
