import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/platform";
import { PAGE_SANDBOX, pageDocument, readMessage } from "./page";

/** How long a page gets to load before it's reported as it stands. */
const LOAD_WAIT_MS = 12_000;
/** How long after loading its console is still listened to (timers, fetches). */
const SETTLE_MS = 800;
const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 500;

type CheckRequest = { id: string; html: string; width: number };

type ConsoleEntry = { level: "log" | "info" | "warning" | "error" | "debug"; text: string };

type CheckReport = {
    contentHeight: number;
    loaded: boolean;
    console: ConsoleEntry[];
    omittedConsoleMessages?: number;
    text: string;
};

/**
 * Hive's `preview_html` tool (`src-tauri/src/html.rs`): the backend asks
 * (`html://check`) and the page is loaded in a hidden frame as wide as asked,
 * sandboxed as in the transcript; its height, console and text go back
 * (`answer_html_check`). Mounted in `App`.
 */
export function useHtmlCheckRuntime() {
    useEffect(() => {
        if (!isTauri) return;
        const unlisten = listen<CheckRequest>("html://check", ({ payload }) => {
            void checkPage(payload).then((report) =>
                invoke("answer_html_check", { id: payload.id, report })
            );
        });
        return () => void unlisten.then((stop) => stop());
    }, []);
}

function checkPage({ html, width }: CheckRequest): Promise<CheckReport> {
    return new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", PAGE_SANDBOX);
        frame.setAttribute("aria-hidden", "true");
        frame.tabIndex = -1;
        // On screen but unseen, behind the app: Chromium stops drawing (and
        // animation frames) in cross-origin frames that are off screen.
        Object.assign(frame.style, {
            position: "fixed",
            left: "0",
            top: "0",
            width: `${width}px`,
            height: "800px",
            border: "0",
            opacity: "0",
            pointerEvents: "none",
            zIndex: "-1",
            colorScheme: "dark"
        });

        const entries: ConsoleEntry[] = [];
        let omitted = 0;
        let height = 0;
        let loaded = false;
        let text = "";
        let settle: number | undefined;

        const finish = () => {
            window.removeEventListener("message", onMessage);
            window.clearTimeout(timeout);
            window.clearTimeout(settle);
            frame.remove();
            resolve({
                contentHeight: height,
                loaded,
                console: entries,
                ...(omitted ? { omittedConsoleMessages: omitted } : {}),
                text
            });
        };
        const onMessage = (event: MessageEvent) => {
            const message = readMessage(event, frame);
            if (!message) return;
            switch (message.type) {
                case "size":
                    height = message.height;
                    break;
                case "console":
                    if (entries.length < MAX_MESSAGES) {
                        entries.push({
                            level: message.level === "warn" ? "warning" : message.level,
                            text: message.text.slice(0, MAX_MESSAGE_CHARS)
                        });
                    } else {
                        omitted++;
                    }
                    break;
                case "loaded":
                    loaded = true;
                    text = message.text;
                    settle = window.setTimeout(finish, SETTLE_MS);
                    break;
            }
        };
        const timeout = window.setTimeout(finish, LOAD_WAIT_MS);
        window.addEventListener("message", onMessage);
        frame.srcdoc = pageDocument(html);
        document.body.appendChild(frame);
    });
}
