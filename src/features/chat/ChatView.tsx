import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Attachment, BackgroundTask, Message } from "@/proto";
import { cn } from "@/lib/cn";
import { chats, useActiveChat, useChatsStore, useSession } from "@/features/chats/store";
import { Composer, ContextMeter, FolderPicker } from "@/features/composer";
import { BranchPicker } from "@/features/git";
import { ClaudeMark } from "@/features/models";
import { UNTITLED } from "@/features/sidebar/ChatRow";
import { toast } from "@/ui";
import { useChatConfig } from "./config";
import { AssistantMessage } from "./transcript/AssistantMessage";
import { ChatCwd, KnownFiles, LiveTasks } from "./transcript/context";
import { foldPath, fullPath, parseFileRef, resolveFileRef } from "./transcript/filePaths";
import { Minimap } from "./transcript/Minimap";
import { minimapItems, type MinimapItem } from "./transcript/minimapItems";
import { pathOf } from "./transcript/tools";
import { UserMessage } from "./transcript/UserMessage";
import { answer, queue, send, stop, useChatBusy, useChatStore } from "./store";
import { pendingInput } from "./fold";
import { InputCard } from "./InputCard";
import { SecretCard } from "./SecretCard";
import { BackgroundTasks } from "./BackgroundTasks";
import { QueuedTray } from "./SessionTrays";
import { SubagentView } from "./SubagentView";
import { findSpawnIn, subagentName } from "./transcript/subagents";

/**
 * The column the transcript and the composer share: centred, at most
 * `max-w-3xl`, inside the pane's `px-6`. Beside open panels it narrows with
 * the main column, which the layout keeps at least `MAIN_MIN_WIDTH` wide.
 */
export const laneClassName = "mx-auto w-full max-w-3xl";

const NO_TASKS: readonly BackgroundTask[] = [];

/** How close to the end counts as following it, in px. */
const FOLLOW_SLACK = 48;

/**
 * The main pane: the open chat's transcript with the composer under it, or,
 * in the new-chat view (and before a chat's first prompt), the composer
 * centred under a heading. Under the composer sits the folder the chat
 * works in: picked in the new-chat view, fixed once the chat exists.
 */
export function ChatView() {
    const chat = useActiveChat();
    const messages = useChatStore((s) => s.messages);
    const loaded = useChatStore((s) => s.loaded);
    const busy = useChatBusy();
    const session = useSession(chat?.id);
    const newChatCwd = useChatsStore((s) => s.newChatCwd);
    const cwd = chat?.cwd ?? newChatCwd ?? "";
    const known = useMemo(() => knownFiles(messages, cwd), [messages, cwd]);
    const [config, setConfig] = useChatConfig();
    const lastReply = messages.findLast((m) => m.role === "assistant");
    const waiting = lastReply?.status === "streaming" ? pendingInput(lastReply.parts) : undefined;
    // The subagent thread shown in place of the chat's, if any.
    const openSpawn = useChatsStore((s) => s.subagent.at(-1));

    const onSend = (prompt: string, attachments: Attachment[]) => {
        // The draft stays until there's somewhere to send it.
        if (!chat && !newChatCwd) {
            toast.error({ title: "Choose a folder first", description: "Pick where the agent should work." });
            return false;
        }
        void send(prompt, attachments);
    };

    const composer = (
        <>
            {session?.secrets[0] && <SecretCard key={session.secrets[0].id} request={session.secrets[0]} />}
            {session && (
                <QueuedTray
                    queued={session.queued}
                    held={session.held}
                    onSendNow={queue.sendNow}
                    onCancel={queue.cancel}
                />
            )}
            {waiting && (
                <ChatCwd value={cwd || undefined}>
                    <InputCard
                        key={waiting.requestId}
                        part={waiting}
                        onAnswer={(response) => answer(waiting.requestId, response)}
                    />
                </ChatCwd>
            )}
            <Composer
                chatId={chat?.id ?? null}
                cwd={cwd}
                config={config}
                onConfigChange={setConfig}
                onSend={onSend}
                onStop={stop}
                busy={busy}
            />
            <div className="mt-1.5 flex items-center gap-1">
                <FolderPicker
                    cwd={cwd || null}
                    locked={!!chat}
                    onChange={(path) => useChatsStore.getState().setNewChatCwd(path)}
                />
                <BranchPicker cwd={cwd || null} />
                <span className="ml-auto flex items-center gap-1">
                    {session && (
                        <BackgroundTasks tasks={session.tasks} messages={messages} onStop={queue.stopTask} />
                    )}
                    <ContextMeter context={session?.context} />
                </span>
            </div>
        </>
    );

    // A chat opening: its messages are on their way.
    if (chat && !loaded) return <div className="h-full w-full" />;

    if (messages.length === 0) {
        return (
            <div className="relative flex h-full w-full flex-col items-center justify-center pb-16">
                <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-text">
                    What should we build?
                </h1>
                <div className="w-full">
                    <Bottom>{composer}</Bottom>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col">
            <ChatCwd value={cwd || undefined}>
                <KnownFiles value={known}>
                    <LiveTasks value={session?.tasks ?? NO_TASKS}>
                        {openSpawn ? (
                            <SubagentView id={openSpawn} messages={messages} />
                        ) : (
                            <TranscriptScroller key={chat?.id} follow={messages} minimap={messages}>
                                {messages.map((message) => (
                                    <MessageView key={message.id} message={message} />
                                ))}
                            </TranscriptScroller>
                        )}
                    </LiveTasks>
                </KnownFiles>
            </ChatCwd>
            {!openSpawn && <Bottom>{composer}</Bottom>}
        </div>
    );
}

/**
 * The main column's head while a chat is open: its title after its agent's
 * mark, then the subagent threads open in it, `title / a / b`. Each crumb
 * but the last steps back out to it.
 */
export function ChatHeader() {
    const chat = useActiveChat();
    const messages = useChatStore((s) => s.messages);
    const path = useChatsStore((s) => s.subagent);
    if (!chat) return null;
    const crumbs = [
        chat.title?.trim() || UNTITLED,
        ...path.map((id) => {
            const found = findSpawnIn(messages, id);
            return found ? subagentName(found.spawn) : "Subagent";
        })
    ];
    return (
        <header className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 px-3">
            <ClaudeMark className="size-3.5 shrink-0" />
            {crumbs.map((name, depth) => {
                const last = depth === crumbs.length - 1;
                return (
                    <span
                        key={depth}
                        className={cn("flex min-w-0 items-center gap-1.5 text-[13px]", !last && "max-w-[40%] shrink")}
                    >
                        {depth > 0 && <span className="shrink-0 text-muted/60">/</span>}
                        {last ? (
                            <h1 className="truncate text-text">{name}</h1>
                        ) : (
                            <button
                                type="button"
                                onClick={() => chats.openSubagentDepth(depth)}
                                className="cursor-pointer truncate text-muted transition-colors hover:text-text"
                            >
                                {name}
                            </button>
                        )}
                    </span>
                );
            })}
        </header>
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
 * Given `minimap`, its prompts run as ticks down the left edge.
 */
export function TranscriptScroller({
    follow,
    minimap,
    children
}: {
    follow?: unknown;
    minimap?: Message[];
    children?: ReactNode;
}) {
    const scrollerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const pinnedRef = useRef(true);

    useLayoutEffect(() => {
        const scroller = scrollerRef.current;
        if (scroller && pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
    }, [follow]);

    const items = useMemo(() => (minimap ? minimapItems(minimap) : []), [minimap]);
    const [ticks] = useState(() => new Map<string, HTMLSpanElement>());

    // Lights the ticks whose turns are on screen: a turn runs from its
    // prompt to the next one. Written straight onto the ticks, not rendered.
    const markInView = useCallback(() => {
        const el = scrollerRef.current;
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
        const el = scrollerRef.current;
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
        const el = scrollerRef.current;
        const turn = el?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(item.id)}"]`);
        if (!el || !turn) return;
        const top = turn.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 24;
        // Unpinned so streaming doesn't pull it away; reaching the bottom pins again.
        pinnedRef.current = false;
        el.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    };

    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <div
                ref={scrollerRef}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    pinnedRef.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
                    scheduleMark();
                }}
                className="min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]"
            >
                <div ref={contentRef} className={cn(laneClassName, "flex flex-col gap-5 py-6")}>
                    {children}
                </div>
            </div>
            {minimap && (
                <Minimap
                    items={items}
                    ticks={ticks}
                    onSelect={jumpTo}
                    onWheel={(deltaY) => scrollerRef.current?.scrollBy({ top: deltaY })}
                />
            )}
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
        // A turn starts here, for the minimap.
        <div data-turn={message.id} className="flex flex-col">
            <UserMessage message={message} />
        </div>
    ) : (
        <AssistantMessage message={message} />
    );
}
