import type { ReactNode } from "react";
import { ArrowRightIcon, ArrowsLeftRightIcon } from "@phosphor-icons/react";
import type { Chat, Handoff, HarnessId } from "@/proto";
import { chats, useChatsStore } from "@/features/chats";
import { HARNESS_LABELS, HarnessMark, useCatalog } from "@/features/models";
import { Divider } from "./Dividers";

const icon = <ArrowsLeftRightIcon className="size-3.5 shrink-0" />;

/** A harness's mark and the model's name (the harness's when there's none). */
function Endpoint({ harness, model }: { harness: HarnessId; model?: string }) {
    const catalog = useCatalog(harness);
    const label = model
        ? (catalog?.models.find((m) => m.id === model)?.label ?? model)
        : (catalog?.models.find((m) => m.id === catalog.defaultModel)?.label ?? HARNESS_LABELS[harness]);
    return (
        <span className="inline-flex items-center gap-1 align-middle">
            <HarnessMark harness={harness} className="size-3 shrink-0" />
            <span className="text-text/85">{label}</span>
        </span>
    );
}

/** A divider that opens another chat. */
function Link({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
    if (!onClick) return children;
    return (
        <button type="button" onClick={onClick} className="w-full cursor-pointer transition-opacity hover:opacity-80">
            {children}
        </button>
    );
}

/**
 * Where the chat went to another agent, as a line across the transcript:
 * under the last message before it, or at the top of a new chat continuing
 * another (a click opens that one, while it's there). It shimmers while the
 * summary for the new agent is written; prompts wait for it.
 */
export function HandoffDivider({ handoff }: { handoff: Handoff }) {
    const source = useChatsStore((s) =>
        handoff.fromChatId ? s.chats.find((c) => c.id === handoff.fromChatId) : undefined
    );
    const pending = handoff.status === "summarizing" && !handoff.delivered;
    const route = (
        <>
            <Endpoint harness={handoff.fromHarness} model={handoff.fromModel} />
            <ArrowRightIcon className="mx-1 inline size-3 align-middle" />
            <Endpoint harness={handoff.toHarness} model={handoff.toModel} />
        </>
    );
    return (
        <Link onClick={source ? () => chats.select(source.id) : undefined}>
            <Divider icon={icon}>
                {/* Narrow columns keep the route: the icon says what it is. */}
                {pending ? (
                    <span className="shimmer">Summarizing for the handoff · </span>
                ) : (
                    handoff.fromChatId && "Continued · "
                )}
                {route}
            </Divider>
        </Link>
    );
}

/** The end of a chat a new one continues: a divider for each, opening it. */
export function ContinuedDividers({ chatId }: { chatId: string }) {
    const all = useChatsStore((s) => s.chats);
    const next: Chat[] = all.filter((c) => c.handoffs?.[0]?.fromChatId === chatId);
    return next.map((chat) => (
        <Link key={chat.id} onClick={() => chats.select(chat.id)}>
            <Divider icon={icon}>
                Continued in a new chat ·{" "}
                <Endpoint harness={chat.config.harness} model={chat.config.model} />
            </Divider>
        </Link>
    ));
}
