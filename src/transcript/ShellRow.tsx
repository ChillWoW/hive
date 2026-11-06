import { use, useEffect, useMemo, useState, type ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { CaretRightIcon, GlobeSimpleIcon, XIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/cn";
import { formatElapsed, useNow } from "@/lib/time";
import type { BackgroundTask } from "@/proto";
import { ChatCwd, TaskChat } from "./context";
import { ShellOutput } from "./ShellOutput";
import { failureOf, plainText, seenShells as seen, servedUrl, useTaskOutput } from "./shellTask";
import { chipContent, type ToolPart } from "./tools";

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
    rail,
    body
}: {
    part: ToolPart;
    task: BackgroundTask | undefined;
    rail: (tone: "running" | "failed" | undefined) => ReactNode;
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
        <div className="flex min-w-0">
            {rail(failure ? "failed" : live ? "running" : undefined)}
            <div className="ml-2 min-w-0 flex-1">
                <Collapsible.Root open={open} onOpenChange={setOpen}>
                    <div className="group/item relative flex h-8 w-full min-w-0 items-center gap-2 text-xs">
                        {/* The whole row opens it; the port sits above. */}
                        <Collapsible.Trigger
                            aria-label={`${open ? "Hide" : "Show"} output of ${detail}`}
                            className="absolute inset-0 outline-none"
                        />
                        <span
                            className={cn(
                                "pointer-events-none shrink-0 text-dark-200 group-hover/item:text-dark-50",
                                live && "shimmer"
                            )}
                        >
                            {live ? "Running" : "Ran"}
                        </span>
                        <span className="pointer-events-none min-w-0 truncate text-dark-250 group-hover/item:text-dark-100">
                            {detail}
                        </span>
                        {live && url && (
                            <button
                                type="button"
                                onClick={() => void openUrl(url.url).catch(() => {})}
                                aria-label={`Open ${url.url}`}
                                className={cn(
                                    "relative z-10 inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[11px] text-info outline-none",
                                    "bg-info/12 transition-colors hover:bg-info/20 focus-visible:bg-info/20"
                                )}
                            >
                                <GlobeSimpleIcon className="size-3" />:{url.port}
                            </button>
                        )}
                        {failure && (
                            <span className="pointer-events-none inline-flex h-[18px] shrink-0 items-center gap-1 rounded bg-danger/12 px-1.5 text-[11px] text-danger">
                                <XIcon weight="bold" className="size-2.5" />
                                {failure}
                            </span>
                        )}
                        <span className="pointer-events-none ml-auto flex shrink-0 items-center gap-0.5">
                            <span className="px-1 text-[11px] text-dark-250 tabular-nums">{meta}</span>
                            <span className="flex size-[18px] items-center justify-center text-dark-250 opacity-0 transition-opacity group-hover/item:opacity-100 group-has-[[data-panel-open]]/item:opacity-100">
                                <CaretRightIcon
                                    weight="bold"
                                    className={cn(
                                        "size-3 transition-transform duration-200",
                                        open && "rotate-90"
                                    )}
                                />
                            </span>
                        </span>
                    </div>
                    <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0">
                        {readable ? (
                            <ShellOutput chatId={chatId} taskId={task.id} className="pt-0.5 pb-2" />
                        ) : (
                            body
                        )}
                    </Collapsible.Panel>
                </Collapsible.Root>
            </div>
        </div>
    );
}
