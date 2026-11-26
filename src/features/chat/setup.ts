import { create } from "zustand";
import type { Attachment, Chat, Message, WorktreeStep } from "@/proto";

/**
 * How a new chat's worktree is coming along, as its setup card shows it:
 * naming the branch (semantic naming only), checking it out, then the agent
 * starting on the first prompt. In memory only: a chat made before a reload
 * shows just its worktree.
 *
 * The one being made lives in `draft` (the new-chat view shows it under the
 * prompt); once its chat exists it moves to `byChat`, where the chat's
 * transcript finds it.
 */

export type SetupStageId = "name" | "checkout" | "agent";
export type SetupStatus = "pending" | "running" | "done" | "failed";

export type SetupStage = {
    id: SetupStageId;
    status: SetupStatus;
    startedAt?: number;
    endedAt?: number;
    /** The branch, on the naming and checkout rows. */
    branch?: string;
};

export type WorktreeSetup = {
    /** Null until the chat exists. */
    chatId: string | null;
    /** The first prompt, shown while there's no chat to show it in. */
    prompt: string;
    attachments: Attachment[];
    startedAt: number;
    /** Set once the agent answered, or the setup failed. */
    endedAt?: number;
    error?: string;
    stages: SetupStage[];
};

type SetupsState = { draft: WorktreeSetup | null; byChat: Record<string, WorktreeSetup> };

export const useSetups = create<SetupsState>()(() => ({ draft: null, byChat: {} }));

/** A copy of `setup` to change, stages and all. */
const copy = (setup: WorktreeSetup): WorktreeSetup => ({ ...setup, stages: setup.stages.map((s) => ({ ...s })) });

/** Starts `id`, finishing whatever ran before it. */
function start(setup: WorktreeSetup, id: SetupStageId, now: number) {
    if (!stage(setup, id)) return;
    for (const s of setup.stages) {
        if (s.id === id) {
            if (s.status === "pending") {
                s.status = "running";
                s.startedAt = now;
            }
            return;
        }
        if (s.status === "running" || s.status === "pending") {
            s.status = "done";
            s.startedAt ??= now;
            s.endedAt = now;
        }
    }
}

const stage = (setup: WorktreeSetup, id: SetupStageId) => setup.stages.find((s) => s.id === id);

function editDraft(change: (setup: WorktreeSetup) => void) {
    const draft = useSetups.getState().draft;
    if (!draft) return;
    const next = copy(draft);
    change(next);
    useSetups.setState({ draft: next });
}

export const setups = {
    /** The new-chat view's worktree is being made; `naming` with semantic branch names. */
    begin(prompt: string, attachments: Attachment[], naming: boolean) {
        const now = Date.now();
        const stages: SetupStage[] = [
            ...(naming ? [{ id: "name" as const, status: "running" as const, startedAt: now }] : []),
            { id: "checkout", status: naming ? "pending" : "running", startedAt: naming ? undefined : now },
            { id: "agent", status: "pending" }
        ];
        useSetups.setState({ draft: { chatId: null, prompt, attachments, startedAt: now, stages } });
    },

    step(step: WorktreeStep) {
        const now = Date.now();
        editDraft((setup) => {
            if (step.step === "naming") return start(setup, "name", now);
            const name = stage(setup, "name");
            if (name) name.branch = step.branch;
            start(setup, "checkout", now);
            const checkout = stage(setup, "checkout");
            if (checkout) checkout.branch = step.branch;
        });
    },

    /** The chat exists; the prompt is on its way to the agent. */
    created(chat: Chat) {
        const draft = useSetups.getState().draft;
        if (!draft) return;
        const next = copy(draft);
        next.chatId = chat.id;
        // The branch as made (numbered if the name was taken).
        const checkout = stage(next, "checkout");
        if (checkout && chat.worktree) checkout.branch = chat.worktree.branch;
        start(next, "agent", Date.now());
        useSetups.setState((s) => ({ draft: null, byChat: { ...s.byChat, [chat.id]: next } }));
    },

    failed(error: string) {
        const now = Date.now();
        editDraft((setup) => {
            setup.endedAt = now;
            setup.error = error;
            const running = setup.stages.find((s) => s.status === "running");
            if (running) {
                running.status = "failed";
                running.endedAt = now;
            }
        });
    },

    /** Drops a failed draft (a new send, another folder). */
    dismiss() {
        if (useSetups.getState().draft) useSetups.setState({ draft: null });
    },

    /** Ends the chat's setup once its agent has answered: its first reply has something in it, or is over. */
    observe(chatId: string, messages: readonly Message[]) {
        const setup = useSetups.getState().byChat[chatId];
        if (!setup || setup.endedAt) return;
        const reply = messages.find((m) => m.role === "assistant");
        if (!reply || (reply.parts.length === 0 && reply.status === "streaming")) return;
        const now = Date.now();
        const next = copy(setup);
        const agent = stage(next, "agent");
        if (agent) {
            agent.status = reply.parts.length === 0 && reply.status === "aborted" ? "failed" : "done";
            agent.startedAt ??= now;
            agent.endedAt = now;
        }
        next.endedAt = now;
        useSetups.setState((s) => ({ byChat: { ...s.byChat, [chatId]: next } }));
    }
};

/** The new-chat view's worktree being made (or failed); null otherwise. */
export const useDraftSetup = () => useSetups((s) => s.draft);

/** The chat's worktree setup, if it was made this session. */
export const useChatSetup = (chatId: string | null | undefined) =>
    useSetups((s) => (chatId ? s.byChat[chatId] : undefined));
