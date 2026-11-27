import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { Attachment, BackgroundTask, Message } from "@/proto";
import { cn } from "@/lib/cn";
import { chats, useActiveChat, useChatsStore, useSession, workDir } from "@/features/chats/store";
import { Composer, ContextMeter, useComposerStore } from "@/features/composer";
import { WorkspacePicker } from "@/features/git";
import { HarnessMark } from "@/features/models";
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
import { setups, useChatSetup, useDraftSetup, type WorktreeSetup } from "./setup";
import { WorktreeDivider } from "./transcript/WorktreeDivider";
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

/** How long the composer takes to move between the new-chat view's centre and a thread's foot. */
const MORPH_MS = 320;

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
    // Where the agent works: a chat's worktree, else its folder.
    const cwd = (chat ? workDir(chat) : newChatCwd) ?? "";
    const workspace = useComposerStore((s) => s.newChatWorkspace);
    const base = useComposerStore((s) => s.newChatBase);
    const draftSetup = useDraftSetup();
    const chatSetup = useChatSetup(chat?.id);
    // The new-chat view's worktree being made, or why it couldn't be.
    const making = !chat && !!draftSetup && !draftSetup.error;
    const failedSetup = !chat ? draftSetup?.error && draftSetup : undefined;
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
            {failedSetup && (
                <div className="mb-3 px-1">
                    <WorktreeDivider setup={failedSetup} />
                </div>
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
                <WorkspacePicker
                    chat={chat ?? null}
                    folder={(chat?.cwd ?? newChatCwd) || null}
                    cwd={cwd || null}
                    frozen={making}
                    onFolderChange={(path) => {
                        useChatsStore.getState().setNewChatCwd(path);
                        useComposerStore.getState().setNewChatBase(null);
                        setups.dismiss();
                    }}
                    workspace={workspace}
                    onWorkspaceChange={(next) => useComposerStore.getState().setNewChatWorkspace(next)}
                    base={base}
                    onBaseChange={(next) => useComposerStore.getState().setNewChatBase(next)}
                />
                <span className="ml-auto flex items-center gap-1">
                    {session && (
                        <BackgroundTasks tasks={session.tasks} messages={messages} onStop={queue.stopTask} />
                    )}
                    <ContextMeter context={session?.context} />
                </span>
            </div>
        </>
    );

    // A worktree being made, then its chat until the prompt lands: the
    // prompt with the setup under it.
    const pendingSetup = making ? draftSetup : chat && messages.length === 0 ? chatSetup : undefined;

    // Nothing to show yet: the composer sits centred under a heading. A chat
    // still opening keeps the layout that was up, so the composer never
    // blinks out between the two.
    const wantCentred = !pendingSetup && messages.length === 0;
    const settled = !!pendingSetup || !chat || loaded;
    const [centred, setCentred] = useState(wantCentred);
    const bottomRef = useRef<HTMLDivElement>(null);
    // Where the composer was when the layout last flipped, for its morph.
    const fromRef = useRef<number | null>(null);
    // The flip waits for a commit of the old layout, so the composer can be
    // measured where it was; that commit is never painted.
    useLayoutEffect(() => {
        if (!settled || centred === wantCentred) return;
        fromRef.current = bottomRef.current?.getBoundingClientRect().top ?? null;
        setCentred(wantCentred);
    }, [settled, centred, wantCentred]);
    useLayoutEffect(() => {
        const el = bottomRef.current;
        const from = fromRef.current;
        fromRef.current = null;
        if (!el || from === null) return;
        const dy = from - el.getBoundingClientRect().top;
        if (!dy || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
            duration: MORPH_MS,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)"
        });
    }, [centred]);

    let top: ReactNode;
    if (centred) {
        top = (
            <div className="flex min-h-0 flex-1 flex-col justify-end">
                <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-text">
                    What should we build?
                </h1>
            </div>
        );
    } else if (pendingSetup) {
        top = (
            <TranscriptScroller follow={pendingSetup}>
                <PendingPrompt setup={pendingSetup} />
                <WorktreeDivider setup={pendingSetup} worktree={chat?.worktree} />
            </TranscriptScroller>
        );
    } else {
        top = (
            <ChatCwd value={cwd || undefined}>
                <KnownFiles value={known}>
                    <LiveTasks value={session?.tasks ?? NO_TASKS}>
                        {openSpawn ? (
                            <SubagentView id={openSpawn} messages={messages} />
                        ) : (
                            <TranscriptScroller key={chat?.id} follow={messages} minimap={messages}>
                                {messages.map((message, at) => (
                                    <Fragment key={message.id}>
                                        <MessageView message={message} />
                                        {/* The chat's worktree, under its first prompt. */}
                                        {at === 0 && chat?.worktree && (
                                            <WorktreeDivider setup={chatSetup} worktree={chat.worktree} />
                                        )}
                                    </Fragment>
                                ))}
                            </TranscriptScroller>
                        )}
                    </LiveTasks>
                </KnownFiles>
            </ChatCwd>
        );
    }

    // The composer keeps its place in the tree across the layouts, so it
    // stays mounted (focus, caret) while it moves.
    return (
        <div className={cn("flex h-full w-full flex-col", centred && "pb-16")}>
            {top}
            {(centred || pendingSetup || !openSpawn) && (
                <Bottom key="composer" ref={bottomRef}>
                    {composer}
                </Bottom>
            )}
            {centred && <div className="flex-1" />}
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
            <HarnessMark harness={chat.config.harness} className="size-3.5 shrink-0" />
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

/** The first prompt while its chat's worktree is made: there's no chat to show it in yet. */
function PendingPrompt({ setup }: { setup: WorktreeSetup }) {
    const message = useMemo<Message>(
        () => ({
            id: "pending",
            role: "user",
            parts: [{ kind: "text", id: "pending", text: setup.prompt }],
            attachments: setup.attachments,
            createdAt: setup.startedAt
        }),
        [setup.prompt, setup.attachments, setup.startedAt]
    );
    return <MessageView message={message} />;
}

/** Under the transcript (or the heading): the composer. */
function Bottom({
    ref,
    className,
    children
}: {
    ref?: Ref<HTMLDivElement>;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <div ref={ref} className="shrink-0 px-6 pb-3">
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
