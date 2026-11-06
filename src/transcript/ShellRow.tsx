import { use, useEffect, useMemo, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/cn";
import { formatElapsed, useNow } from "@/lib/time";
import type { BackgroundTask } from "@/proto";
import { ChatCwd, TaskChat } from "./context";
import { ShellOutput } from "./ShellOutput";
import { failureOf, plainText, seenShells as seen, servedUrl, useTaskOutput } from "./shellTask";
import { chipContent, type ToolPart } from "./tools";
import { lineBodyClassName, lineClassName, panelTransition, targetClassName, verbClassName } from "./line";

/** How often a running shell's row reads its output for its port and failures. */
const ROW_POLL_MS = 4000;

/**
 * A command the agent left running, on its rail line: "Running" while the
 * session lists its task, with the address it serves (opens in the browser),
 * how its latest run went ("1 failed") and how long it has run; open,
 * the end of its output, read live. Once it's gone, "Ran" and how long it
 * ran (when this window saw it), its last failure kept; open, the call as
 * any other's (`body`).
 */
export function ShellRow({
    part,
    task,
    icon,
    body
}: {
    part: ToolPart;
    task: BackgroundTask | undefined;
    icon: (tone: "running" | "failed" | undefined) => ReactNode;
    body: ReactNode;
}) {
    const chatId = use(TaskChat);
    const cwd = use(ChatCwd);
    const [open, setOpen] = useState(false);

    const live = !!task;
    const readable = live && (task.kind === "shell" || task.kind === "monitor") && !!chatId;
    // Read slowly for the row's badges; the open output reads faster on its own.
    const { output } = useTaskOutput(chatId, readable ? task.id : undefined, ROW_POLL_MS);
    const text = useMemo(() => (output ? plainText(output.output) : ""), [output]);

    // Remembered as it runs, so the row still says how it went once it's gone.
    let memo = seen.get(part.id);
    if (live && !memo) {
        memo = { start: task.startedAt ?? Date.now() };
        seen.set(part.id, memo);
    }
    if (memo && live && task.startedAt != null) memo.start = task.startedAt;
    if (memo && !live && memo.end === undefined) memo.end = Date.now();
    if (memo && live) memo.end = undefined;

    const url = (text && servedUrl(text)) || memo?.url;
    const failure = text ? failureOf(text) : (memo?.failure ?? null);
    useEffect(() => {
        const m = seen.get(part.id);
        if (!m || !text) return;
        // A server's address scrolls out of the 8 KiB tail: kept once seen.
        if (url) m.url = url;
        m.failure = failure;
    }, [part.id, text, url, failure]);

    const now = useNow(live);
    const elapsed = memo ? (memo.end ?? Math.max(now, memo.start)) - memo.start : null;
    const { detail } = chipContent(part.call, cwd, part.output);

    const meta = live
        ? elapsed !== null && formatElapsed(elapsed, { pad: true })
        : elapsed !== null
          ? `in background · ${formatElapsed(elapsed)}`
          : "in background";

    return (
        <Collapsible.Root open={open} onOpenChange={setOpen}>
            <div className={cn(lineClassName, "relative")}>
                {/* The whole line opens it; the address sits above. */}
                <Collapsible.Trigger
                    aria-label={`${open ? "Hide" : "Show"} output of ${detail}`}
                    className="absolute inset-0 cursor-pointer outline-none"
                />
                <span className="pointer-events-none contents">
                    {icon(failure ? "failed" : live ? "running" : undefined)}
                </span>
                <span className={cn(verbClassName, "pointer-events-none", live && "shimmer")}>
                    {live ? "Running" : "Ran"}
                </span>
                <span className={cn(targetClassName, "pointer-events-none")}>{detail}</span>
                {live && url && (
                    <button
                        type="button"
                        onClick={() => void openUrl(url.url).catch(() => {})}
                        aria-label={`Open ${url.url}`}
                        className="relative z-10 shrink-0 text-xs text-info outline-none hover:underline focus-visible:underline"
                    >
                        {url.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                    </button>
                )}
                {failure && <span className="pointer-events-none shrink-0 text-xs text-danger">{failure}</span>}
                <span className="pointer-events-none ml-auto shrink-0 pl-3 text-xs text-dark-300 tabular-nums">
                    {meta}
                </span>
            </div>
            <Collapsible.Panel className={panelTransition}>
                <div className={lineBodyClassName}>
                    {readable ? <ShellOutput chatId={chatId} taskId={task.id} className="pt-0.5 pb-2" /> : body}
                </div>
            </Collapsible.Panel>
        </Collapsible.Root>
    );
}
