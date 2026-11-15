import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { useChatBusy, useChatStore, type AssistantMessage, type Message } from "./store";

/**
 * The column the transcript and the composer share: centred, at most
 * `max-w-3xl`, inside the pane's `px-6`. Beside open panels it narrows with
 * the main column, which the layout keeps at least `MAIN_MIN_WIDTH` wide.
 */
export const laneClassName = "mx-auto w-full max-w-3xl";

/** How close to the end counts as following it, in px. */
const FOLLOW_SLACK = 48;

/**
 * The main pane: the chat's transcript with the composer under it, or,
 * before its first prompt, the composer centred under a heading.
 */
export function ChatView() {
    const messages = useChatStore((s) => s.messages);
    const send = useChatStore((s) => s.send);
    const busy = useChatBusy();

    if (messages.length === 0) {
        return (
            <div className="relative flex h-full w-full flex-col items-center justify-center pb-16">
                <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-text">
                    What should we build?
                </h1>
                <div className="w-full">
                    <Bottom>
                        <Composer onSend={send} busy={busy} autoFocus />
                    </Bottom>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col">
            <TranscriptScroller follow={messages}>
                {messages.map((message) => (
                    <MessageView key={message.id} message={message} />
                ))}
            </TranscriptScroller>
            <Bottom>
                <Composer onSend={send} busy={busy} autoFocus />
            </Bottom>
        </div>
    );
}

/** Under the transcript (or the heading): the composer. */
function Bottom({ className, children }: { className?: string; children?: ReactNode }) {
    return (
        <div className="shrink-0 px-6 pb-3">
            <div className={cn(laneClassName, className)}>{children}</div>
        </div>
    );
}

/**
 * The transcript's scroller: messages down the lane, its scrollbar kept
 * clear of it. While scrolled to the end it stays there as `follow` changes.
 */
export function TranscriptScroller({
    follow,
    children
}: {
    follow?: unknown;
    children?: ReactNode;
}) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const pinnedRef = useRef(true);

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (scroller && pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
    }, [follow]);

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scrollerRef}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    pinnedRef.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
                }}
                className="min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]"
            >
                <div className={cn(laneClassName, "flex flex-col gap-5 py-6")}>{children}</div>
            </div>
        </div>
    );
}

function MessageView({ message }: { message: Message }) {
    if (message.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[85%] rounded-xl bg-raised px-3.5 py-2 text-sm leading-6 break-words whitespace-pre-wrap text-text">
                    {message.text}
                </div>
            </div>
        );
    }
    return <AssistantView message={message} />;
}

function AssistantView({ message }: { message: AssistantMessage }) {
    const waiting = message.streaming && !message.text;
    return (
        <div className="flex flex-col gap-2">
            {waiting && <span className="animate-pulse text-sm leading-6 text-muted">Thinking…</span>}
            {message.text && <Markdown streaming={message.streaming}>{message.text}</Markdown>}
            {message.error && (
                <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-danger">
                    {message.error}
                </div>
            )}
        </div>
    );
}
