import { type CSSProperties, useEffect, useLayoutEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { ChatDetailsCard } from "./details/ChatDetailsCard";
import { detailsLayout } from "./details/layout";
import { useChatDetailsStore } from "./details/store";
import {
    chats,
    isBusy,
    useChat,
    useChatMessages,
    useChatsStore,
    useSession,
    workDir,
    type TranscriptMessage
} from "@/chats";
import {
    Composer,
    FolderPicker,
    QuestionWizard,
    useComposerStore
} from "@/composer";
import {
    fitConfig,
    useCatalog,
    useCommands,
    useCatalogs
} from "@/harnesses";
import { BranchPicker, useGitRepo, WorkspaceChip, WorkspacePicker } from "@/git";
import { useShortcut } from "@/keybindings";
import type { Attachment, BackgroundTask, ChatConfig, MessagePart } from "@/proto";
import { useMinuteClock } from "@/lib/time";
import { useSettingsStore } from "@/settings/store";
import { ContinuedRows, HandoffCard, LiveTasks, promptText, TaskChat, Transcript } from "@/transcript";
import { continueIn, handoffBlocked } from "./handoff";
import { MorphHeight } from "@/ui";
import { AgentUpdates } from "./AgentUpdates";
import { BackgroundTasks } from "./BackgroundTasks";
import { autoCompactAt, isStaleForCompact } from "./compaction";
import { type CompactAction, ContextRing } from "./ContextRing";
import { StaleCompactChip } from "./StaleCompactChip";
import { GoalTray } from "./GoalTray";
import { QueuedTray } from "./QueuedTray";
import { SecretRequestCard } from "./SecretRequestCard";
import { SubagentView } from "./SubagentView";
import { trayStackClassName } from "./tray";
import { UsageLimitTray } from "./UsageLimitTray";
import { UsageRing } from "./UsageRing";

type InputPart = Extract<MessagePart, { kind: "input" }>;

/** The question the live turn is waiting on, if any. */
function pendingInput(messages: TranscriptMessage[]): InputPart | undefined {
    const last = messages.findLast((m) => m.role === "assistant");
    if (last?.status !== "streaming") return undefined;
    return last.parts.find(
        (p): p is InputPart => p.kind === "input" && !p.resolved
    );
}

/**
 * The main pane: the active chat's transcript with the composer under it,
 * or, for the new-chat view, the composer centred until the first prompt.
 * While the agent waits on a question the wizard takes the composer's place,
 * and a secret it asked for (`Session.secrets`) its card.
 */
export function ChatView() {
    const chatId = useChatsStore((s) => s.activeChatId);
    const chat = useChat(chatId);
    const session = useSession(chatId);
    const { messages, loading, error } = useChatMessages(chatId);
    const newChat = useComposerStore((s) => s.newChat);
    const setNewChat = useComposerStore((s) => s.setNewChat);
    const [needFolder, setNeedFolder] = useState(false);
    const subagent = useChatsStore((s) => s.subagent.at(-1));
    const openSubagent = useChatsStore((s) => s.openSubagent);
    // A new chat gets a worktree only in a checkout with a commit to start from.
    const newRepo = useGitRepo(chat ? null : newChat.cwd)?.repo;
    const worktreeMode = !chat && newChat.workspace === "worktree" && !!newRepo?.commit;
    // A base deleted since it was picked falls back to the checked-out branch.
    const base =
        newChat.base && newRepo?.branches.some((b) => b.name === newChat.base)
            ? newChat.base
            : null;

    const visible = useCatalogs();
    const chatCatalog = useCatalog(chat?.config.harness);
    // A new chat's remembered harness may be gone (or hidden); fall back to the first.
    const newCatalog =
        visible.find((c) => c.id === newChat.config.harness) ?? visible[0];
    const catalog = chat ? chatCatalog : newCatalog;
    // Where the agent runs: a started chat's worktree or folder, else the new chat's.
    const folder = chat ? workDir(chat) : newChat.cwd;
    const commands = useCommands(catalog, folder, session?.commands);
    // New chats always get workspace-write; nothing in the UI picks it.
    const remembered: ChatConfig = { ...newChat.config, sandbox: "workspace-write" };
    const config: ChatConfig = chat
        ? chat.config
        : newCatalog
          ? fitConfig(newCatalog, remembered)
          : remembered;

    const setConfig = (next: ChatConfig) => {
        if (chat) {
            chats.updateConfig(chat.id, next).catch(() => {});
        } else {
            setNewChat({ config: next });
        }
    };

    useShortcut("togglePlan", () => {
        if (!catalog?.capabilities.plan) return false;
        setConfig({ ...config, plan: !config.plan });
    });

    const shown = messages.filter((m) => m.delivery?.state !== "queued");
    const queued = messages.filter((m) => m.delivery?.state === "queued");
    const streaming = shown.findLast((m) => m.role === "assistant")?.status === "streaming";
    const busy =
        streaming ||
        isBusy(session?.status) ||
        messages.some((m) => m.delivery?.state === "sending");
    const input = pendingInput(shown);
    // A question first; secrets wait their turn, oldest first.
    const secret = input ? undefined : session?.secrets?.[0];

    // Another harness's model in the picker continues the chat there; a
    // handed-off chat's first prompt waits for the summary it carries.
    const hasPrompt = shown.some((m) => m.role === "user" && !m.delivery);
    const handoff = chat && hasPrompt
        ? {
              blocked: handoffBlocked(busy, hasPrompt),
              onPick: (next: ChatConfig) => {
                  continueIn(chat, next).catch((e: unknown) =>
                      console.warn("[chat] handoff failed", e)
                  );
              }
          }
        : undefined;
    const hold =
        chat?.handoff && !chat.handoff.delivered && chat.handoff.status === "summarizing"
            ? "Waiting for the handoff summary"
            : undefined;

    const sendTo = (
        prompt: string,
        attachments: Attachment[] = [],
        options?: { background?: boolean }
    ) => {
        if (chat) {
            void chats.send({ chatId: chat.id }, prompt, attachments);
            return true;
        }
        if (!newChat.cwd) {
            setNeedFolder(true);
            return false;
        }
        void chats.send(
            {
                cwd: newChat.cwd,
                config,
                worktree: worktreeMode ? { base } : undefined
            },
            prompt,
            attachments,
            options
        );
        return true;
    };

    const retry = (message: TranscriptMessage) => {
        chats.discard(message.id);
        sendTo(promptText(message), message.attachments ?? []);
    };

    // The goal tray's Clear, mid-turn: sent once the stopped turn has ended.
    const [clearGoal, setClearGoal] = useState(false);
    useEffect(() => {
        if (!clearGoal || busy) return;
        setClearGoal(false);
        if (chat && session?.goal) sendTo("/goal clear");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearGoal, busy]);

    // The ring's Compact context: a started chat whose harness has `/compact`.
    const compact: CompactAction | undefined =
        chat && commands.some((c) => c.kind === "command" && c.name === "compact")
            ? {
                  run: () => sendTo("/compact"),
                  disabled: !shown.some((m) => m.role === "assistant")
                      ? "Start a conversation before compacting."
                      : busy
                        ? "Compacting waits until the agent finishes."
                        : undefined
              }
            : undefined;

    const claudeSettings = useSettingsStore((s) => s.settings.claude);
    const compactAt = autoCompactAt(
        chat?.config.harness,
        claudeSettings.autoCompactWindow,
        chat?.context?.window
    );

    // Back in a big Claude chat whose prompt cache expired: compact before
    // the next prompt unless the chip is switched to full history. Keyed by
    // the chat's last message, so each idle spell starts out on.
    const now = useMinuteClock();
    const stale =
        claudeSettings.idleCompaction === "onReturn" &&
        !!compact &&
        !compact.disabled &&
        isStaleForCompact(chat, now);
    const staleKey = `${chat?.id}:${chat?.lastMessageAt}`;
    const [keepFull, setKeepFull] = useState<string | null>(null);
    const compactFirst = stale && keepFull !== staleKey;

    const send = (
        prompt: string,
        attachments: Attachment[] = [],
        options?: { background?: boolean }
    ) => {
        if (compactFirst && !prompt.trimStart().startsWith("/")) {
            // The prompt waits in the queue until the compaction's turn ends.
            sendTo("/compact");
        }
        return sendTo(prompt, attachments, options);
    };

    const hero = !chatId && shown.length === 0;

    // The details card floats at the pane's top right; the column slides
    // aside (then narrows) to clear it.
    // A callback ref: the pane mounts only once there's a transcript to show.
    const [pane, setPane] = useState<HTMLDivElement | null>(null);
    const [paneWidth, setPaneWidth] = useState(0);
    useLayoutEffect(() => {
        if (!pane) return;
        setPaneWidth(pane.clientWidth);
        const observer = new ResizeObserver(() => setPaneWidth(pane.clientWidth));
        observer.observe(pane);
        return () => observer.disconnect();
    }, [pane]);
    const detailsOpen = useChatDetailsStore((s) => s.open);
    const [findOpen, setFindOpen] = useState(false);
    const details = detailsLayout(paneWidth, detailsOpen && !!chat && paneWidth > 0);
    const laneStyle = details.inline
        ? ({ "--lane-shift": `${details.shift}px`, "--lane-max": `${details.lane}px` } as CSSProperties)
        : undefined;
    const laneClassName = details.inline
        ? "relative right-(--lane-shift) max-w-(--lane-max) transition-[right,max-width] duration-150 ease-out"
        : undefined;

    const bottom = (
        <div className="shrink-0 px-6 pb-3">
            <div className={cn("mx-auto w-full max-w-3xl", !hero && laneClassName)}>
                <div className={trayStackClassName}>
                    {!input && !secret && <UsageLimitTray harness={config.harness} />}
                    {chat && session?.goal && !input && !secret && (
                        <GoalTray
                            goal={session.goal}
                            working={busy}
                            onCommand={(arg) => {
                                if (arg === "resume" || !busy) {
                                    sendTo(`/goal ${arg}`);
                                    return;
                                }
                                // Stopping pauses the goal; it's cleared once
                                // the turn has ended, rather than after Codex
                                // takes another turn toward it.
                                setClearGoal(true);
                                void chats.interrupt(chat.id).catch(() => {});
                            }}
                        />
                    )}
                    {chatId && queued.length > 0 && (
                        <QueuedTray chatId={chatId} messages={queued} running={busy} />
                    )}
                </div>
                {/* The box grows into the wizard and back rather than jumping. */}
                <MorphHeight
                    swapKey={
                        input && chat
                            ? `question:${input.requestId}`
                            : secret && chat
                              ? `secret:${secret.id}`
                              : "composer"
                    }
                >
                    {input && chat ? (
                        <QuestionWizard
                            key={input.requestId}
                            questions={input.questions}
                            onSubmit={(answers) => chats.answer(chat.id, input.requestId, answers)}
                        />
                    ) : secret && chat ? (
                        <SecretRequestCard
                            key={secret.id}
                            request={secret}
                            onAnswer={(value) => chats.answerSecret(chat.id, secret.id, value)}
                        />
                    ) : (
                        <Composer
                            chatId={chatId}
                            config={config}
                            onConfigChange={setConfig}
                            lockedHarness={!!chat}
                            handoff={handoff}
                            hold={hold}
                            busy={busy}
                            canStop={!!chat && streaming && !!catalog?.capabilities.interrupt}
                            steering={!!catalog?.capabilities.steering}
                            canAttach={!!catalog?.capabilities.attachments}
                            commands={commands}
                            cwd={folder}
                            onSend={send}
                            onStop={chat ? () => void chats.interrupt(chat.id).catch(() => {}) : undefined}
                            placeholder={hero ? "What should we work on?" : "Reply…"}
                        />
                    )}
                </MorphHeight>
                <div className="mt-1 flex h-6 min-w-0 items-center gap-1 px-1">
                    <FolderPicker
                        cwd={chat ? chat.cwd : newChat.cwd}
                        locked={!!chat}
                        onChange={(cwd) => {
                            setNeedFolder(false);
                            // A base belongs to the folder it was picked in.
                            setNewChat({ cwd, base: null });
                        }}
                    />
                    {chat ? (
                        <>
                            <BranchPicker cwd={workDir(chat)} locked />
                            <WorkspaceChip chat={chat} />
                        </>
                    ) : (
                        <>
                            {/* A worktree's base is picked in the workspace chip. */}
                            {!worktreeMode && <BranchPicker cwd={newChat.cwd} />}
                            <WorkspacePicker
                                cwd={newChat.cwd}
                                value={newChat.workspace}
                                onChange={(workspace) => setNewChat({ workspace })}
                                base={base}
                                onBaseChange={(next) => setNewChat({ base: next })}
                            />
                        </>
                    )}
                    {needFolder && !chat && !newChat.cwd && (
                        <span className="truncate text-xs text-warning">
                            Choose a folder for the agent to work in
                        </span>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                        {chat && (
                            <BackgroundTasks
                                chatId={chat.id}
                                harness={chat.config.harness}
                                tasks={session?.background}
                                messages={shown}
                            />
                        )}
                        {stale && (
                            <StaleCompactChip
                                tokens={chat?.context?.tokens ?? 0}
                                on={compactFirst}
                                onChange={(on) => setKeepFull(on ? null : staleKey)}
                            />
                        )}
                        <UsageRing harness={config.harness} />
                        <ContextRing
                            usage={chat?.context}
                            compact={compact}
                            autoCompactAt={compactAt}
                        />
                    </div>
                </div>
            </div>
        </div>
    );

    if (chat && subagent) {
        return (
            <SubagentView
                chatId={chat.id}
                id={subagent}
                messages={shown}
                tasks={session?.background}
                cwd={folder ?? undefined}
                harness={chat.config.harness}
            />
        );
    }

    if (hero) {
        return (
            <div className="relative flex h-full w-full flex-col items-center justify-center pb-16">
                <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-dark-50">
                    What should we build?
                </h1>
                <div className="w-full">{bottom}</div>
                <AgentUpdates />
            </div>
        );
    }

    return (
        <LiveTasks value={session?.background ?? NO_TASKS}>
            <TaskChat value={chat?.id}>
                <div ref={setPane} style={laneStyle} className="relative flex h-full w-full flex-col">
                    {loading ? (
                        <div className="flex-1" />
                    ) : (
                        <Transcript
                            key={chatId ?? "new"}
                            messages={shown}
                            cwd={folder ?? undefined}
                            waiting={!!input || !!secret}
                            error={error}
                            onRetry={retry}
                            onDiscard={(m) => chats.discard(m.id)}
                            worktree={chat?.worktree}
                            agent={catalog?.label}
                            harness={chat?.config.harness}
                            chatId={chat?.id}
                            onOpenSubagent={chat ? (id) => openSubagent(chat.id, id) : undefined}
                            onFindOpenChange={setFindOpen}
                            header={chat?.handoff && <HandoffCard chat={chat} handoff={chat.handoff} />}
                            footer={chat && <ContinuedRows chatId={chat.id} />}
                            className={laneClassName}
                        />
                    )}
                    {bottom}
                    {chat && details.inline && <ChatDetailsCard chat={chat} belowFind={findOpen} />}
                </div>
            </TaskChat>
        </LiveTasks>
    );
}

const NO_TASKS: BackgroundTask[] = [];
