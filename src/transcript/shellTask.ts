import { useCallback, useSyncExternalStore } from "react";
import { chats } from "@/chats";
import { errorMessage } from "@/lib/errors";
import type { BackgroundTask, TaskOutput } from "@/proto";
import type { ToolPart } from "./tools";

/*
 * A background shell's output: read from the agent (the last 8 KiB, through
 * `chats.taskOutput`) and what it says about the shell — the address it
 * serves, whether its latest run failed.
 */

/** What this window saw of a background shell, by tool call id: kept after it ends. */
export type SeenShell = { start: number; end?: number; url?: ServedUrl; failure?: string | null };

export const seenShells = new Map<string, SeenShell>();

/** Claude's (and the mock's) answer to a command it put in the background. */
const BACKGROUNDED = /running in (?:the )?background/i;

/**
 * Whether an exec call is a background shell to draw as one: still running
 * (`task`), seen running by this window, or one whose result says it went
 * to the background.
 */
export function isBackgroundShell(part: ToolPart, task: BackgroundTask | undefined): boolean {
    return !!task || seenShells.has(part.id) || BACKGROUNDED.test(part.output ?? "");
}

/* eslint-disable no-control-regex -- terminal escape sequences, on purpose */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC = /\x1b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** Terminal output as plain text: escape sequences out, `\r` rewrites kept. */
export function plainText(output: string): string {
    return output
        .replace(OSC, "")
        .replace(CSI, "")
        .replace(ESC, "")
        .split("\n")
        .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
        .join("\n")
        .trimEnd();
}

/** A local address the shell serves, and its port. */
export type ServedUrl = { url: string; port: string };

const LOCAL_URL =
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(?:\/[^\s'"`<>)\]]*)?/i;
const LISTENING = /\b(?:listening|running|serving|started|available)\b[^\n]*?\bport\s*:?\s*(\d{2,5})\b/i;

/** The first local address the output names (dev servers print theirs as they start). */
export function servedUrl(text: string): ServedUrl | null {
    const url = LOCAL_URL.exec(text);
    if (url) {
        const href = url[0].replace(/[.,;:]+$/, "").replace(/\/\/(?:0\.0\.0\.0|\[::\])/, "//localhost");
        return { url: href, port: url[1] };
    }
    const listening = LISTENING.exec(text);
    return listening ? { url: `http://localhost:${listening[1]}`, port: listening[1] } : null;
}

const count = (n: string, one: string, many: string) => `${n} ${n === "1" ? one : many}`;

/**
 * Lines that report a failure, with what to call it. Test runners and
 * compilers first (they say how many), then a bare error line.
 */
const FAILURES: [RegExp, (m: RegExpExecArray) => string][] = [
    [/test result: FAILED\..*?(\d+) failed/, (m) => count(m[1], "failed", "failed")],
    [/^\s*Tests?:?\s+.*?\b(\d+) failed\b/, (m) => count(m[1], "failed", "failed")],
    [/^\s*([1-9]\d*) fail\b/, (m) => count(m[1], "failed", "failed")],
    [/\bFound ([1-9]\d*) errors?\b/, (m) => count(m[1], "error", "errors")],
    [/^error(?:\[\w+\])?:/, () => "Error"],
    [/^\s*(?:Uncaught |Unhandled )?[A-Z]?\w*Error: /, () => "Error"],
    [/\bInternal server error\b/i, () => "Error"],
    [/\bERR!/, () => "Error"]
];

/** Lines that report a clean run, so an older failure above them is over. */
const SUCCESSES: RegExp[] = [
    /test result: ok\./,
    /^\s*Tests?:?\s+(?!.*\bfailed\b).*\bpassed\b/,
    /^\s*0 fail\b/,
    /\bFound 0 errors\b/,
    /\bready in\b/i,
    /\bcompiled successfully\b/i,
    /\bhmr update\b/i,
    /\bpage reload\b/i
];

/**
 * How the shell's latest run went, read from the bottom up: the nearest
 * failure line names it ("1 failed", "3 errors", "Error"), unless a line
 * reporting success comes after it. Null when nothing says it failed.
 */
export function failureOf(text: string): string | null {
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
        const line = lines[i];
        if (SUCCESSES.some((re) => re.test(line))) return null;
        for (const [re, label] of FAILURES) {
            const m = re.exec(line);
            if (m) return label(m);
        }
    }
    return null;
}

export type TaskOutputState = {
    output: TaskOutput | null;
    error: string | null;
};

const EMPTY: TaskOutputState = { output: null, error: null };

/** One poll per task, shared by everything showing it, at the fastest rate any of them asks. */
type Poll = {
    chatId: string;
    taskId: string;
    state: TaskOutputState;
    subs: Map<symbol, { every: number; notify: () => void }>;
    timer?: ReturnType<typeof setTimeout>;
    reading: boolean;
};

const polls = new Map<string, Poll>();

function schedule(poll: Poll) {
    if (poll.timer || poll.reading || poll.subs.size === 0) return;
    const every = Math.min(...[...poll.subs.values()].map((s) => s.every));
    poll.timer = setTimeout(() => {
        poll.timer = undefined;
        read(poll);
    }, every);
}

function read(poll: Poll) {
    if (poll.reading || poll.subs.size === 0) return;
    poll.reading = true;
    chats
        .taskOutput(poll.chatId, poll.taskId)
        .then(
            (output) => {
                poll.state = { output, error: null };
            },
            (e) => {
                poll.state = { output: poll.state.output, error: errorMessage(e) };
            }
        )
        .finally(() => {
            poll.reading = false;
            for (const sub of poll.subs.values()) sub.notify();
            schedule(poll);
        });
}

/**
 * A background task's output, read now and then every `every` ms while
 * mounted (nothing without a task). Every reader of one task shares a poll.
 */
export function useTaskOutput(
    chatId: string | undefined,
    taskId: string | undefined,
    every: number
): TaskOutputState {
    const key = chatId && taskId ? `${chatId}\n${taskId}` : null;
    const subscribe = useCallback(
        (notify: () => void) => {
            if (!key || !chatId || !taskId) return () => {};
            let poll = polls.get(key);
            if (!poll) {
                poll = {
                    chatId,
                    taskId,
                    state: EMPTY,
                    subs: new Map(),
                    reading: false
                };
                polls.set(key, poll);
            }
            const id = Symbol();
            poll.subs.set(id, { every, notify });
            // A new reader reads now; the pace follows the fastest one left.
            clearTimeout(poll.timer);
            poll.timer = undefined;
            read(poll);
            const current = poll;
            return () => {
                current.subs.delete(id);
                if (current.subs.size === 0) {
                    clearTimeout(current.timer);
                    current.timer = undefined;
                }
            };
        },
        [key, chatId, taskId, every]
    );
    return useSyncExternalStore(subscribe, () => (key ? (polls.get(key)?.state ?? EMPTY) : EMPTY));
}
