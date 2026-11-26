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

/**
 * Dev builds can pose as another platform, to see its chrome: `?platform=macos`
 * in the URL, or `localStorage["outcode.platform"] = "macos"` then reload.
 */
function devOverride(): Platform | null {
    if (!import.meta.env.DEV || typeof window === "undefined") return null;
    let value: string | null = new URLSearchParams(window.location.search).get("platform");
    try {
        value ??= window.localStorage.getItem("outcode.platform");
    } catch {
        // Storage blocked: no override.
    }
    return value === "macos" || value === "windows" || value === "linux" ? value : null;
}

const detected = detectPlatform();
export const platform = devOverride() ?? detected;
export const isMac = platform === "macos";
/** Posing as macOS elsewhere: the system draws no traffic lights, so the app fakes them. */
export const fakeMac = isMac && detected !== "macos";

/** What the system's file manager calls showing a file in its folder. */
export const REVEAL_LABEL =
    platform === "macos"
        ? "Reveal in Finder"
        : platform === "windows"
          ? "Show in Explorer"
          : "Show in folder";
