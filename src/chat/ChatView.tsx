import { useState } from "react";
import {
    chats,
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
import type { Attachment, ChatConfig, MessagePart } from "@/proto";
import { Transcript } from "@/transcript";
import { MorphHeight } from "@/ui";
import { AgentUpdates } from "./AgentUpdates";
import { BackgroundTasks } from "./BackgroundTasks";
import { ContextRing } from "./ContextRing";
import { QueuedTray } from "./QueuedTray";
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
 * While the agent waits on a question the wizard takes the composer's place.
 */
export function ChatView() {
    const chatId = useChatsStore((s) => s.activeChatId);
    const chat = useChat(chatId);
    const session = useSession(chatId);
    const { messages, loading, error } = useChatMessages(chatId);
    const newChat = useComposerStore((s) => s.newChat);
    const setNewChat = useComposerStore((s) => s.setNewChat);
    const [needFolder, setNeedFolder] = useState(false);
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
    const commands = useCommands(catalog, chat ? workDir(chat) : newChat.cwd, session?.commands);
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
        session?.status === "working" ||
        session?.status === "awaitingInput" ||
        messages.some((m) => m.delivery?.state === "sending");
    const input = pendingInput(shown);

    const sendTo = (prompt: string, attachments: Attachment[] = []) => {
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
            attachments
        );
        return true;
    };

    const retry = (message: TranscriptMessage) => {
        const text = message.parts
            .flatMap((p) => (p.kind === "text" ? [p.text] : []))
            .join("\n\n");
        chats.discard(message.id);
        sendTo(text, message.attachments ?? []);
    };

    const hero = !chatId && shown.length === 0;

    const bottom = (
        <div className="shrink-0 px-6 pb-3">
            <div className="mx-auto w-full max-w-3xl">
                {chatId && queued.length > 0 && (
                    <QueuedTray chatId={chatId} messages={queued} running={busy} />
                )}
                {/* The box grows into the wizard and back rather than jumping. */}
                <MorphHeight swapKey={input && chat ? `question:${input.requestId}` : "composer"}>
                    {input && chat ? (
                        <QuestionWizard
                            key={input.requestId}
                            questions={input.questions}
                            onSubmit={(answers) => chats.answer(chat.id, input.requestId, answers)}
                        />
                    ) : (
                        <Composer
                            chatId={chatId}
                            config={config}
                            onConfigChange={setConfig}
                            lockedHarness={!!chat}
                            busy={busy}
                            canStop={!!chat && streaming && !!catalog?.capabilities.interrupt}
                            steering={!!catalog?.capabilities.steering}
                            canAttach={!!catalog?.capabilities.attachments}
                            commands={commands}
                            cwd={chat ? workDir(chat) : newChat.cwd}
                            onSend={sendTo}
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
                            {worktreeMode ? (
                                <BranchPicker
                                    cwd={newChat.cwd}
                                    base={base}
                                    onBaseChange={(next) => setNewChat({ base: next })}
                                />
                            ) : (
                                <BranchPicker cwd={newChat.cwd} />
                            )}
                            <WorkspacePicker
                                cwd={newChat.cwd}
                                value={newChat.workspace}
                                onChange={(workspace) => setNewChat({ workspace })}
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
                                tasks={session?.background}
                                messages={shown}
                            />
                        )}
                        <UsageRing harness={config.harness} />
                        <ContextRing usage={chat?.context} />
                    </div>
                </div>
            </div>
        </div>
    );

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
        <div className="flex h-full w-full flex-col">
            {loading ? (
                <div className="flex-1" />
            ) : (
                <Transcript
                    key={chatId ?? "new"}
                    messages={shown}
                    cwd={chat ? workDir(chat) : (newChat.cwd ?? undefined)}
                    waiting={!!input}
                    error={error}
                    onRetry={retry}
                    onDiscard={(m) => chats.discard(m.id)}
                />
            )}
            {bottom}
        </div>
    );
}
