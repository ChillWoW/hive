/**
 * False under a plain `bun run dev`, where the page is served to a browser and no
 * Tauri APIs exist. Anything that would `invoke` has to check this first.
 */
export const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type Platform = "macos" | "windows" | "linux";

/** From the webview UA, so it stays synchronous and needs no plugin. */
function detectPlatform(): Platform {
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    if (/mac|iphone|ipad|ipod/i.test(ua)) return "macos";
    if (/win/i.test(ua)) return "windows";
    return "linux";
}

export const platform = detectPlatform();
export const isMac = platform === "macos";

/** What the system's file manager calls showing a file in its folder. */
export const REVEAL_LABEL =
    platform === "macos"
        ? "Reveal in Finder"
        : platform === "windows"
          ? "Show in Explorer"
          : "Show in folder";
