import type { ReactNode } from "react";
import { ArrowRightIcon, ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { chats, useChat, useChatsStore } from "@/chats";
import { HarnessIcon, useCatalog } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { Chat, Handoff, HarnessId } from "@/proto";

/** A harness's mark and the model's name (its id when the catalog doesn't list it). */
function Endpoint({ harness, model }: { harness: HarnessId; model?: string }) {
    const catalog = useCatalog(harness);
    const label = model
        ? (catalog?.models.find((m) => m.id === model)?.label ?? model)
        : (catalog?.label ?? harness);
    return (
        <span className="flex min-w-0 items-center gap-1">
            <HarnessIcon harness={harness} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate text-dark-100">{label}</span>
        </span>
    );
}

/** A divider across the transcript, drawn as a compaction's; a button when it leads somewhere. */
function Divider({
    label,
    live,
    onClick,
    children
}: {
    label: string;
    live?: boolean;
    onClick?: () => void;
    children: ReactNode;
}) {
    const body = (
        <>
            <ArrowsLeftRightIcon className="size-3.5 shrink-0 text-dark-200" />
            <span className={cn("shrink-0 text-dark-200", live && "shimmer")}>{label}</span>
            {children}
        </>
    );
    return (
        <div role="separator" className="flex min-w-0 items-center gap-3 py-1 text-xs">
            <span className="h-px flex-1 bg-dark-700" />
            {onClick ? (
                <button
                    type="button"
                    onClick={onClick}
                    className="flex min-w-0 max-w-[80%] items-center gap-1.5 rounded-sm transition-opacity hover:opacity-80"
                >
                    {body}
                </button>
            ) : (
                <span className="flex min-w-0 max-w-[80%] items-center gap-1.5">{body}</span>
            )}
            <span className="h-px flex-1 bg-dark-700" />
        </div>
    );
}

/**
 * The top of a chat handed off from another (`Chat.handoff`), as t3code
 * shows a provider switch: one divider, "Context handoff pending" while the
 * summary is written, then "Context handoff", with the old agent and model
 * → this chat's. A click opens the chat it came from, while it's there.
 */
export function HandoffCard({ chat, handoff }: { chat: Chat; handoff: Handoff }) {
    const source = useChat(handoff.fromChatId);
    const pending = handoff.status === "summarizing" && !handoff.delivered;
    return (
        <Divider
            label={pending ? "Context handoff pending" : "Context handoff"}
            live={pending}
            onClick={source ? () => chats.select(source.id) : undefined}
        >
            <Endpoint harness={handoff.fromHarness} model={handoff.fromModel} />
            <ArrowRightIcon className="size-3 shrink-0 text-dark-250" />
            <Endpoint harness={chat.config.harness} model={chat.config.model} />
        </Divider>
    );
}

/** The end of a chat that was handed off: a divider per chat continuing it, opening it. */
export function ContinuedRows({ chatId }: { chatId: string }) {
    const next = useChatsStore((s) => s.chats).filter((c) => c.handoff?.fromChatId === chatId);
    return next.map((chat) => (
        <Divider key={chat.id} label="Continued in" onClick={() => chats.select(chat.id)}>
            <Endpoint harness={chat.config.harness} model={chat.config.model} />
        </Divider>
    ));
}
