import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { useWorktreeSetup, type TranscriptMessage } from "@/chats";
import { runAction, useShortcut } from "@/keybindings";
import { cn } from "@/lib/cn";
import type { HarnessId, Worktree } from "@/proto";
import { WorktreeSetupCard } from "./WorktreeSetupCard";
import { AssistantMessage } from "./AssistantMessage";
import { ChatCwd, OpenSubagent } from "./context";
import { Minimap } from "./Minimap";
import { minimapItems, type MinimapItem } from "./minimapItems";
import { DETAILS_CARD_GAP, DETAILS_CARD_WIDTH } from "@/chat/details/layout";
import { FindBar } from "./FindBar";
import { CompactionRow } from "./parts";
import { promptText } from "./text";
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
    /** The chat's worktree, shown under its first prompt. */
    worktree?: Worktree;
    /** The harness's name, for the worktree setup's "Start agent" step. */
    agent?: string;
    /** The chat's harness, for its subagents' avatars. */
    harness?: HarnessId;
    /** The chat shown: its latest reply gets the turn's changes and Undo. Unset for a subagent's thread. */
    chatId?: string;
    /** Opens a subagent row's thread; unset, rows aren't clickable. */
    onOpenSubagent?: (id: string) => void;
    /** The find bar opened or closed (it takes the details card's spot). */
    onFindOpenChange?: (open: boolean) => void;
    /** Under the messages, inside the scroller (the composer's spacer). */
    className?: string;
};

/** A prompt that is `/compact` and nothing else: shown as its divider, not a bubble. */
function isBareCompact(message: TranscriptMessage): boolean {
    if (message.role !== "user" || message.attachments?.length) return false;
    return promptText(message).trim().toLowerCase() === "/compact";
}

const hasCompaction = (message: TranscriptMessage | undefined) =>
    message?.role === "assistant" && message.parts.some((p) => p.kind === "compaction");

/**
 * Whether a `/compact` followed by `reply` reads as a compaction: its reply
 * has one, or is still to come. One that ended without (refused before it
 * started) keeps its bubble, with whatever the reply said.
 */
const compacting = (reply: TranscriptMessage | undefined) =>
    !reply || hasCompaction(reply) || (reply.role === "assistant" && reply.status === "streaming");

/** The worktree made for a prompt's chat, as it was being made if that was this session. */
function SetupSlot({ messageId, worktree, agent }: { messageId: string; worktree?: Worktree; agent?: string }) {
    return <WorktreeSetupCard setup={useWorktreeSetup(messageId)} worktree={worktree} agent={agent} />;
}

/** A `/compact` on its way, before its reply has said anything. */
function PendingCompaction() {
    return (
        <CompactionRow
            part={{ kind: "compaction", id: "pending", status: "running", auto: false }}
            streaming
        />
    );
}

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
    worktree,
    agent,
    harness,
    chatId,
    onOpenSubagent,
    onFindOpenChange,
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

    // Find in chat. The query outlives closing the bar, for the next Mod+F.
    const [findOpen, setFindOpen] = useState(false);
    const [findQuery, setFindQuery] = useState("");
    const [findFocus, setFindFocus] = useState(0);
    useShortcut("findInChat", () => {
        setFindOpen(true);
        setFindFocus((n) => n + 1);
    });
    useEffect(() => {
        onFindOpenChange?.(findOpen);
    }, [findOpen, onFindOpenChange]);
    useEffect(() => () => onFindOpenChange?.(false), [onFindOpenChange]);
    const closeFind = (refocus: boolean) => {
        setFindOpen(false);
        if (refocus) runAction("focusComposer");
    };

    const lastMessage = messages.at(-1);
    const firstUser = messages.find((m) => m.role === "user")?.id;

    const items = useMemo(() => minimapItems(messages, isBareCompact), [messages]);
    const ticks = useRef(new Map<string, HTMLSpanElement>()).current;

    // Lights the ticks whose turns are on screen: a turn runs from its
    // prompt to the next one. Written straight onto the ticks, not rendered.
    const markInView = useCallback(() => {
        const el = scrollRef.current;
        if (!el || ticks.size === 0) return;
        const view = el.getBoundingClientRect();
        const turns = [...el.querySelectorAll<HTMLElement>("[data-turn]")];
        const contentBottom = contentRef.current?.getBoundingClientRect().bottom ?? view.bottom;
        turns.forEach((turn, i) => {
            const top = turn.getBoundingClientRect().top;
            const bottom = turns[i + 1]?.getBoundingClientRect().top ?? contentBottom;
            const tick = ticks.get(turn.dataset.turn!);
            if (tick) tick.dataset.inView = String(bottom > view.top && top < view.bottom);
        });
    }, [ticks]);

    const frame = useRef(0);
    const scheduleMark = useCallback(() => {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(markInView);
    }, [markInView]);

    useEffect(() => {
        const el = scrollRef.current;
        const content = contentRef.current;
        if (!el || !content) return;
        const observer = new ResizeObserver(scheduleMark);
        observer.observe(el);
        observer.observe(content);
        return () => {
            observer.disconnect();
            cancelAnimationFrame(frame.current);
        };
    }, [scheduleMark]);
    useEffect(scheduleMark, [items, scheduleMark]);

    const jumpTo = (item: MinimapItem) => {
        const el = scrollRef.current;
        const turn = el?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(item.id)}"]`);
        if (!el || !turn) return;
        const top = turn.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24;
        // Unpinned so streaming doesn't pull it away; reaching the bottom pins again.
        pin(false);
        el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    };

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scrollRef}
                onScroll={() => {
                    onScroll();
                    scheduleMark();
                }}
                className="min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]"
            >
                <ChatCwd value={cwd}>
                <OpenSubagent value={onOpenSubagent}>
                    <div
                        ref={contentRef}
                        className={cn("mx-auto flex w-full max-w-3xl flex-col gap-5 py-6", className)}
                    >
                        {messages.map((message, i) =>
                            isBareCompact(message) &&
                            message.delivery?.state !== "failed" &&
                            compacting(messages[i + 1]) ? (
                                // The reply's divider stands for it; until
                                // that arrives, one of its own.
                                hasCompaction(messages[i + 1]) ? null : (
                                    <PendingCompaction key={message.id} />
                                )
                            ) : message.role === "user" ? (
                                <div key={message.id} data-turn={message.id} className="flex flex-col gap-5">
                                    <UserMessage
                                        message={message}
                                        onRetry={onRetry && (() => onRetry(message))}
                                        onDiscard={onDiscard && (() => onDiscard(message))}
                                    />
                                    <SetupSlot
                                        messageId={message.id}
                                        worktree={message.id === firstUser ? worktree : undefined}
                                        agent={agent}
                                    />
                                </div>
                            ) : (
                                <AssistantMessage
                                    key={message.id}
                                    message={message}
                                    waiting={waiting && message === lastMessage}
                                    harness={harness}
                                    turnOf={message === lastMessage ? chatId : undefined}
                                />
                            )
                        )}
                        {error && <p className="text-sm text-danger">{error}</p>}
                    </div>
                </OpenSubagent>
                </ChatCwd>
            </div>
            {findOpen && (
                // Where the chat details card floats, which moves down under it.
                <div
                    style={{ top: DETAILS_CARD_GAP, right: DETAILS_CARD_GAP, width: DETAILS_CARD_WIDTH }}
                    className="absolute z-30"
                >
                    <FindBar
                        content={contentRef}
                        scroller={scrollRef}
                        query={findQuery}
                        onQueryChange={setFindQuery}
                        focusKey={findFocus}
                        onReveal={() => pin(false)}
                        onClose={closeFind}
                    />
                </div>
            )}
            <Minimap
                items={items}
                ticks={ticks}
                onSelect={jumpTo}
                onWheel={(deltaY) => scrollRef.current?.scrollBy({ top: deltaY })}
            />
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
