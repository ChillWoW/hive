import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { Message } from "@/proto";
import { cn } from "@/lib/cn";
import { Composer } from "./Composer";
import { AssistantMessage } from "./transcript/AssistantMessage";
import { ChatCwd, KnownFiles } from "./transcript/context";
import { foldPath, fullPath, parseFileRef, resolveFileRef } from "./transcript/filePaths";
import { pathOf } from "./transcript/tools";
import { UserMessage } from "./transcript/UserMessage";
import { useChatBusy, useChatStore } from "./store";

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
    const stop = useChatStore((s) => s.stop);
    const busy = useChatBusy();
    const cwd = useChatStore((s) => s.cwd);
    const known = useMemo(() => knownFiles(messages, cwd), [messages, cwd]);

    if (messages.length === 0) {
        return (
            <div className="relative flex h-full w-full flex-col items-center justify-center pb-16">
                <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-text">
                    What should we build?
                </h1>
                <div className="w-full">
                    <Bottom>
                        <Composer onSend={send} onStop={stop} busy={busy} autoFocus />
                    </Bottom>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col">
            <ChatCwd value={cwd || undefined}>
                <KnownFiles value={known}>
                    <TranscriptScroller follow={messages}>
                        {messages.map((message) => (
                            <MessageView key={message.id} message={message} />
                        ))}
                    </TranscriptScroller>
                </KnownFiles>
            </ChatCwd>
            <Bottom>
                <Composer onSend={send} onStop={stop} busy={busy} autoFocus />
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

/** Every file the chat's agent read or changed, by `foldPath` of its absolute path. */
function knownFiles(messages: Message[], cwd: string): Set<string> {
    const known = new Set<string>();
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.kind !== "tool") continue;
            const path = pathOf(part.call);
            const ref = path && parseFileRef(path);
            const target = ref && resolveFileRef(cwd || undefined, ref);
            if (target) known.add(foldPath(fullPath(target)));
        }
    }
    return known;
}

function MessageView({ message }: { message: Message }) {
    return message.role === "user" ? (
        <UserMessage message={message} />
    ) : (
        <AssistantMessage message={message} />
    );
}
