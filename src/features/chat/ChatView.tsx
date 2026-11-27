import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { Attachment, BackgroundTask, Chat, ChatConfig, Handoff, HandoffMode, Message } from "@/proto";
import { cn } from "@/lib/cn";
import { chats, useActiveChat, useChatsStore, useSession, workDir } from "@/features/chats/store";
import { Composer, ContextMeter, UsageWarning, useComposerStore } from "@/features/composer";
import { WorkspacePicker } from "@/features/git";
import { HarnessMark } from "@/features/models";
import { ChatMenuItems, DeleteChatDialog, UNTITLED } from "@/features/sidebar";
import { Menu, toast, useInlineRename } from "@/ui";
import { useChatConfig } from "./config";
import { AgentUpdates } from "./AgentUpdates";
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
import { ContinuedDividers, HandoffDivider } from "./transcript/HandoffDivider";
import { handOff, handoffBlocked } from "./handoff";
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
const NO_HANDOFFS: readonly Handoff[] = [];

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

    // A conversation to carry on: another model hands it off.
    const hasPrompt = messages.some((m) => m.role === "user");
    const handoff =
        chat && hasPrompt
            ? {
                  blocked: handoffBlocked(busy, hasPrompt),
                  onHandoff: (next: ChatConfig, mode: HandoffMode) => void handOff(chat, next, mode)
              }
            : undefined;
    const handoffs = chat?.handoffs ?? NO_HANDOFFS;
    const topHandoff = handoffs.find((h) => !h.afterMessageId);

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
            <UsageWarning config={config} />
            <Composer
                chatId={chat?.id ?? null}
                cwd={cwd}
                config={config}
                onConfigChange={setConfig}
                handoff={handoff}
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
    const rootRef = useRef<HTMLDivElement>(null);
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
        // What the composer moves over (the transcript, or the heading) comes
        // in behind it, once it is most of the way there, rather than
        // standing under it from the first frame.
        const above = rootRef.current?.firstElementChild;
        if (above && above !== el) {
            above.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], {
                duration: MORPH_MS,
                easing: "ease-out"
            });
        }
    }, [centred]);

    let top: ReactNode;
    if (centred) {
        top = (
            <div className="flex min-h-0 flex-1 flex-col justify-end">
                {topHandoff ? (
                    // A new chat continuing another: where it came from.
                    <div className={cn(laneClassName, "mb-6 px-6")}>
                        <HandoffDivider handoff={topHandoff} />
                    </div>
                ) : (
                    <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-text">
                        What should we build?
                    </h1>
                )}
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
                            <TranscriptScroller key={chat?.id} follow={[messages, handoffs]} minimap={messages}>
                                {/* A new chat's, continuing another, on top. */}
                                {topHandoff && <HandoffDivider handoff={topHandoff} />}
                                {messages.map((message, at) => (
                                    <Fragment key={message.id}>
                                        <MessageView message={message} />
                                        {/* The chat's worktree, under its first prompt. */}
                                        {at === 0 && chat?.worktree && (
                                            <WorktreeDivider setup={chatSetup} worktree={chat.worktree} />
                                        )}
                                        {handoffs
                                            .filter((h) => h.afterMessageId === message.id)
                                            .map((h) => (
                                                <HandoffDivider key={h.id} handoff={h} />
                                            ))}
                                    </Fragment>
                                ))}
                                {chat && <ContinuedDividers chatId={chat.id} />}
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
        // A chat brings its header (h-9) in above this view: the extra foot
        // keeps the centred composer where it is without one, so it doesn't
        // jump as the header comes in ahead of the morph.
        <div ref={rootRef} className={cn("relative flex h-full w-full flex-col", centred && (chat ? "pb-25" : "pb-16"))}>
            {top}
            {(centred || pendingSetup || !openSpawn) && (
                <Bottom key="composer" ref={bottomRef}>
                    {composer}
                </Bottom>
            )}
            {centred && <div className="flex-1" />}
            {centred && !chat && <AgentUpdates />}
        </div>
    );
}

/**
 * The main column's head while a chat is open: its title after its agent's
 * mark, then the subagent threads open in it, `title / a / b`. Each crumb
 * but the last steps back out to it. With no subagent open, the title opens
 * the chat's menu (the sidebar row's "⋯"); Rename edits it in place.
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
            {/* With no subagent open, the title's menu carries the mark. */}
            {path.length > 0 && <HarnessMark harness={chat.config.harness} className="size-3.5 shrink-0" />}
            {crumbs.map((name, depth) => {
                const last = depth === crumbs.length - 1;
                return (
                    <span
                        key={depth}
                        className={cn("flex min-w-0 items-center gap-1.5 text-[13px]", !last && "max-w-[40%] shrink")}
                    >
                        {depth > 0 && <span className="shrink-0 text-muted/60">/</span>}
                        {last && depth === 0 ? (
                            <TitleMenu chat={chat} title={name} />
                        ) : last ? (
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

/** The header's title as the chat's menu: Rename (in place), Pin, Archive, Delete. */
function TitleMenu({ chat, title }: { chat: Chat; title: string }) {
    const [renaming, setRenaming] = useState(false);
    const [deleting, setDeleting] = useState<Chat | null>(null);
    // Rename puts the caret in the field; the closing menu mustn't take it back.
    const keepFocus = useRef(false);
    const finalFocus = () => {
        const keep = keepFocus.current;
        keepFocus.current = false;
        return !keep;
    };

    return (
        <>
            {renaming ? (
                <span className="-mx-1.5 flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-raised px-1.5 ring-1 ring-border">
                    <HarnessMark harness={chat.config.harness} className="size-3.5 shrink-0" />
                    <TitleField key={chat.id} chat={chat} onDone={() => setRenaming(false)} />
                </span>
            ) : (
                <Menu>
                    <Menu.Trigger
                        aria-label={`Options for ${title}`}
                        className={cn(
                            "-mx-1.5 flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-text outline-none",
                            "transition-colors hover:bg-hover focus-visible:bg-hover data-[popup-open]:bg-hover"
                        )}
                    >
                        <HarnessMark harness={chat.config.harness} className="size-3.5 shrink-0" />
                        <h1 className="truncate">{title}</h1>
                        <CaretDownIcon className="-ml-0.5 size-3 shrink-0 text-muted" weight="bold" />
                    </Menu.Trigger>
                    <Menu.Content finalFocus={finalFocus} className="w-48 min-w-0">
                        <ChatMenuItems
                            chat={chat}
                            onRename={() => {
                                keepFocus.current = true;
                                setRenaming(true);
                            }}
                            onDelete={() => setDeleting(chat)}
                        />
                    </Menu.Content>
                </Menu>
            )}
            <DeleteChatDialog chat={deleting} onClose={() => setDeleting(null)} />
        </>
    );
}

/** The header's title, editable: Enter or leaving saves, Escape cancels. */
function TitleField({ chat, onDone }: { chat: Chat; onDone: () => void }) {
    const { finish, value, inputProps } = useInlineRename({
        onEnter: () => end(true),
        onEscape: () => end(false),
        onBlur: () => end(true)
    });

    const end = (save: boolean) =>
        finish(() => {
            const next = value();
            // Blank keeps the current title.
            if (save && next && next !== chat.title) {
                chats.rename(chat.id, next).catch((error) => console.warn("[chat]", error));
            }
            onDone();
        });

    return (
        <input
            {...inputProps}
            defaultValue={chat.title ?? ""}
            placeholder={UNTITLED}
            aria-label="Chat title"
            spellCheck={false}
            className="w-72 min-w-0 bg-transparent text-[13px] text-text outline-none placeholder:text-muted/75"
        />
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
