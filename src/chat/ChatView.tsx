import { useState } from "react";
import { ArrowBendDownRightIcon } from "@phosphor-icons/react";
import {
    chats,
    useChat,
    useChatMessages,
    useChatsStore,
    useSession,
    type TranscriptMessage
} from "@/chats";
import {
    Composer,
    FolderPicker,
    QuestionWizard,
    SandboxPicker,
    useComposerStore
} from "@/composer";
import {
    fitConfig,
    slashCommands,
    useCatalog,
    useCatalogs
} from "@/harnesses";
import type { ChatConfig, MessagePart } from "@/proto";
import { cn } from "@/lib/cn";
import { Transcript } from "@/transcript";

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

    const visible = useCatalogs();
    const chatCatalog = useCatalog(chat?.config.harness);
    // A new chat's remembered harness may be gone (or hidden); fall back to the first.
    const newCatalog =
        visible.find((c) => c.id === newChat.config.harness) ?? visible[0];
    const catalog = chat ? chatCatalog : newCatalog;
    const config: ChatConfig = chat
        ? chat.config
        : newCatalog
          ? fitConfig(newCatalog, newChat.config)
          : newChat.config;

    const setConfig = (next: ChatConfig) => {
        if (chat) {
            chats.updateConfig(chat.id, next).catch(() => {});
        } else {
            setNewChat({ config: next });
        }
    };

    const shown = messages.filter((m) => m.delivery?.state !== "queued");
    const queued = messages.filter((m) => m.delivery?.state === "queued");
    const streaming = shown.findLast((m) => m.role === "assistant")?.status === "streaming";
    const busy =
        streaming ||
        session?.status === "working" ||
        session?.status === "awaitingInput" ||
        messages.some((m) => m.delivery?.state === "sending");
    const input = pendingInput(shown);

    const sendTo = (prompt: string) => {
        if (chat) {
            void chats.send({ chatId: chat.id }, prompt);
            return true;
        }
        if (!newChat.cwd) {
            setNeedFolder(true);
            return false;
        }
        void chats.send({ cwd: newChat.cwd, config }, prompt);
        return true;
    };

    const retry = (message: TranscriptMessage) => {
        const text = message.parts
            .flatMap((p) => (p.kind === "text" ? [p.text] : []))
            .join("\n\n");
        chats.discard(message.id);
        sendTo(text);
    };

    const hero = !chatId && shown.length === 0;

    const bottom = (
        <div className="shrink-0 px-6 pb-3">
            <div className="mx-auto w-full max-w-3xl">
                {queued.length > 0 && <QueuedTray messages={queued} />}
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
                        commands={slashCommands(catalog, session?.commands)}
                        onSend={sendTo}
                        onStop={chat ? () => void chats.interrupt(chat.id).catch(() => {}) : undefined}
                        placeholder={hero ? "What should we work on?" : "Reply…"}
                    />
                )}
                <div className="mt-1 flex h-6 items-center justify-between gap-2 px-1">
                    <div className="flex min-w-0 items-center gap-1">
                        <FolderPicker
                            cwd={chat ? chat.cwd : newChat.cwd}
                            locked={!!chat}
                            onChange={(cwd) => {
                                setNeedFolder(false);
                                setNewChat({ cwd });
                            }}
                        />
                        {needFolder && !chat && !newChat.cwd && (
                            <span className="truncate text-xs text-warning">
                                Choose a folder for the agent to work in
                            </span>
                        )}
                    </div>
                    <SandboxPicker config={config} onChange={setConfig} />
                </div>
            </div>
        </div>
    );

    if (hero) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center pb-16">
                <h1 className="mb-8 text-center text-2xl font-medium tracking-tight text-dark-50">
                    What should we build?
                </h1>
                <div className="w-full">{bottom}</div>
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
                    cwd={chat?.cwd ?? newChat.cwd ?? undefined}
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

/** Prompts waiting for the running turn to end, tucked behind the composer's top edge. */
function QueuedTray({ messages }: { messages: TranscriptMessage[] }) {
    return (
        <div
            className={cn(
                "mx-4 rounded-t-2xl border border-b-0 border-dark-700 bg-dark-900 px-1 pt-1 pb-1.5",
                "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0"
            )}
        >
            <div className="flex h-6 items-center px-2.5 text-xs font-medium text-dark-200">
                Queued
            </div>
            <ul className="flex flex-col">
                {messages.map((m) => (
                    <li key={m.id} className="flex h-7 items-center gap-2 px-2.5">
                        <ArrowBendDownRightIcon className="size-3.5 shrink-0 text-dark-400" />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-dark-100">
                            {m.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join(" ")}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
