import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@/lib/platform";
import { toast } from "@/ui";
import { browserApi } from "./api";

/**
 * Opens a browser tab in the tabs panel on what was typed (a URL, a host, a
 * search), or a blank one. Its panel tab follows from the backend's
 * announcement (`useBrowserRuntime`).
 */
export function openBrowser(url?: string) {
    browserApi.open(url).catch((error) => {
        toast.error({ title: "Couldn't open a browser tab", description: error instanceof Error ? error.message : String(error) });
    });
}

/** Whether `href` is served from this machine: a dev server, most likely. */
export function isLocalUrl(href: string): boolean {
    try {
        const url = new URL(href);
        if (!/^https?:$/.test(url.protocol)) return false;
        const host = url.hostname.replace(/^\[|\]$/g, "");
        return (
            host === "localhost" ||
            host.endsWith(".localhost") ||
            host === "0.0.0.0" ||
            host === "::1" ||
            /^127\.\d+\.\d+\.\d+$/.test(host)
        );
    } catch {
        return false;
    }
}

/** Opens `url` in the system's browser. */
export function openExternally(url: string) {
    if (isTauri) void openUrl(url);
    else window.open(url, "_blank", "noreferrer");
}

/**
 * Opens a link from a chat or a terminal: a local one (a dev server) in a
 * browser tab here, where the agent can see it too; the rest in the system's
 * browser.
 */
export function openLink(href: string) {
    if (isTauri && isLocalUrl(href)) openBrowser(href);
    else openExternally(href);
}
