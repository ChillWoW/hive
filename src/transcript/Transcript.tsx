import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import type { TranscriptMessage } from "@/chats";
import { cn } from "@/lib/cn";
import { AssistantMessage } from "./AssistantMessage";
import { ChatCwd } from "./context";
import { UserMessage } from "./UserMessage";

/** How close to the bottom still counts as following along, in px. */
const PIN_THRESHOLD = 48;

type TranscriptProps = {
    messages: TranscriptMessage[];
    cwd?: string;
    /** The live turn is held on a question for the user. */
    waiting?: boolean;
    error?: string;
    onRetry?: (message: TranscriptMessage) => void;
    onDiscard?: (message: TranscriptMessage) => void;
    /** Under the messages, inside the scroller (the composer's spacer). */
    className?: string;
};

/**
 * A chat's messages, oldest first. While a turn streams it keeps the newest
 * line in view, unless the user scrolls up to read, in which case it leaves
 * them there with a button back down until they return to the bottom.
 */
export function Transcript({
    messages,
    cwd,
    waiting,
    error,
    onRetry,
    onDiscard,
    className
}: TranscriptProps) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    // The ref is what the observer reads; the state draws the button.
    const pinnedRef = useRef(true);
    const lastScrollTop = useRef(0);
    const [pinned, setPinned] = useState(true);

    const pin = (value: boolean) => {
        pinnedRef.current = value;
        setPinned(value);
    };

    // Any upward move unpins, however small; otherwise a scroll that stays
    // inside the threshold is yanked back by the next chunk. Our own scrolls
    // only go down, so they never unpin.
    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
        if (atBottom) pin(true);
        else if (el.scrollTop < lastScrollTop.current) pin(false);
        lastScrollTop.current = el.scrollTop;
    };

    // Follows the content's height rather than renders: Streamdown paces text
    // and highlights code after the fact, and rows open and close, all without
    // this rendering. Observing the scroller too covers the composer growing.
    useEffect(() => {
        const el = scrollRef.current;
        const content = contentRef.current;
        if (!el || !content) return;
        const observer = new ResizeObserver(() => {
            if (pinnedRef.current) el.scrollTop = el.scrollHeight;
        });
        observer.observe(el);
        observer.observe(content);
        return () => observer.disconnect();
    }, []);

    // A prompt of the user's own always brings them back down.
    const lastUser = messages.findLast((m) => m.role === "user")?.id;
    useEffect(() => {
        const el = scrollRef.current;
        if (!el || !lastUser) return;
        pin(true);
        el.scrollTop = el.scrollHeight;
    }, [lastUser]);

    const scrollToBottom = () => {
        const el = scrollRef.current;
        if (!el) return;
        pin(true);
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    };

    const lastMessage = messages.at(-1);

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]"
            >
                <ChatCwd value={cwd}>
                    <div
                        ref={contentRef}
                        className={cn("mx-auto flex w-full max-w-3xl flex-col gap-5 py-6", className)}
                    >
                        {messages.map((message) =>
                            message.role === "user" ? (
                                <UserMessage
                                    key={message.id}
                                    message={message}
                                    onRetry={onRetry && (() => onRetry(message))}
                                    onDiscard={onDiscard && (() => onDiscard(message))}
                                />
                            ) : (
                                <AssistantMessage
                                    key={message.id}
                                    message={message}
                                    waiting={waiting && message === lastMessage}
                                />
                            )
                        )}
                        {error && <p className="text-sm text-danger">{error}</p>}
                    </div>
                </ChatCwd>
            </div>
            <button
                type="button"
                aria-label="Jump to bottom"
                tabIndex={pinned ? -1 : 0}
                onClick={scrollToBottom}
                className={cn(
                    "absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full",
                    "border border-dark-600 bg-dark-800 text-dark-100 shadow-lg shadow-black/40",
                    "transition-[opacity,translate] duration-200 hover:bg-dark-700 hover:text-dark-50",
                    pinned ? "pointer-events-none translate-y-2 opacity-0" : "opacity-100"
                )}
            >
                <ArrowDownIcon className="size-4" weight="bold" />
            </button>
        </div>
    );
}
