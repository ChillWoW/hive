import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { Message, Worktree, WorktreeStep } from "@/proto";

/**
 * How a new chat's worktree is coming along, as t3code's worktree setup
 * card shows it: naming the branch (semantic naming only), checking it out,
 * then the agent starting on the first prompt. Kept in memory per prompt
 * (its message id), so it outlives neither a reload nor a restart; a chat
 * without one shows only its worktree.
 */

export type SetupStageId = "name" | "checkout" | "agent";
export type SetupStatus = "pending" | "running" | "done" | "failed";

export type SetupStage = {
    id: SetupStageId;
    status: SetupStatus;
    startedAt?: number;
    endedAt?: number;
    /** The branch, for the naming and checkout rows. */
    branch?: string;
};

export type WorktreeSetup = {
    messageId: string;
    /** Null until `create_chat` returns. */
    chatId: string | null;
    startedAt: number;
    /** Set once the agent started, or the setup failed. */
    endedAt?: number;
    error?: string;
    stages: SetupStage[];
    worktree?: Worktree;
};

type SetupsState = { setups: Record<string, WorktreeSetup> };

export const useWorktreeSetups = create<SetupsState>()(immer(() => ({ setups: {} })));

const set = useWorktreeSetups.setState;

function stage(setup: WorktreeSetup, id: SetupStageId) {
    return setup.stages.find((s) => s.id === id);
}

function start(setup: WorktreeSetup, id: SetupStageId, now: number) {
    for (const s of setup.stages) {
        if (s.id === id) break;
        // Anything before it is done by now.
        if (s.status === "running" || s.status === "pending") {
            s.status = "done";
            s.startedAt ??= now;
            s.endedAt = now;
        }
    }
    const s = stage(setup, id);
    if (s && s.status === "pending") {
        s.status = "running";
        s.startedAt = now;
    }
}

function edit(messageId: string, change: (setup: WorktreeSetup) => void) {
    set((s) => {
        const setup = s.setups[messageId];
        if (setup) change(setup);
    });
}

export const setups = {
    /** A prompt's worktree is being made; `naming` with semantic branch names. */
    begin(messageId: string, naming: boolean) {
        const now = Date.now();
        const stages: SetupStage[] = [
            ...(naming ? [{ id: "name" as const, status: "running" as const, startedAt: now }] : []),
            { id: "checkout", status: naming ? "pending" : "running", startedAt: naming ? undefined : now },
            { id: "agent", status: "pending" }
        ];
        set((s) => {
            s.setups[messageId] = { messageId, chatId: null, startedAt: now, stages };
        });
    },

    step(messageId: string, step: WorktreeStep) {
        const now = Date.now();
        edit(messageId, (setup) => {
            if (step.step === "naming") {
                start(setup, "name", now);
                return;
            }
            const name = stage(setup, "name");
            if (name) name.branch = step.branch;
            start(setup, "checkout", now);
            const checkout = stage(setup, "checkout");
            if (checkout) checkout.branch = step.branch;
        });
    },

    /** The chat exists; the prompt is on its way to the agent. */
    created(messageId: string, chatId: string, worktree: Worktree | undefined) {
        const now = Date.now();
        edit(messageId, (setup) => {
            setup.chatId = chatId;
            setup.worktree = worktree;
            // The branch as made (numbered if the name was taken).
            const checkout = stage(setup, "checkout");
            if (checkout && worktree) checkout.branch = worktree.branch;
            start(setup, "agent", now);
        });
    },

    failed(messageId: string, error: string) {
        const now = Date.now();
        edit(messageId, (setup) => {
            if (setup.endedAt) return;
            setup.endedAt = now;
            setup.error = error;
            const s = setup.stages.find((s) => s.status === "running");
            if (s) {
                s.status = "failed";
                s.endedAt = now;
            }
        });
    },

    /** Prompts withdrawn or discarded take their setup with them. */
    drop(messageId: string) {
        set((s) => {
            delete s.setups[messageId];
        });
    },

    /**
     * Ends a chat's setups whose agent has answered: its reply after the
     * prompt has something in it, or is over.
     */
    observe(chatId: string, messages: readonly Message[]) {
        const running = Object.values(useWorktreeSetups.getState().setups).filter(
            (s) => s.chatId === chatId && !s.endedAt
        );
        if (running.length === 0) return;
        const now = Date.now();
        set((s) => {
            for (const { messageId } of running) {
                const at = messages.findIndex((m) => m.id === messageId);
                if (at < 0) continue;
                const reply = messages
                    .slice(at + 1)
                    .find((m) => m.role === "assistant");
                if (!reply || (reply.parts.length === 0 && reply.status === "streaming")) continue;
                const setup = s.setups[messageId];
                const agent = stage(setup, "agent");
                if (agent) {
                    agent.status = "done";
                    agent.startedAt ??= now;
                    agent.endedAt = now;
                }
                setup.endedAt = now;
            }
        });
    }
};

export function useWorktreeSetup(messageId: string | undefined) {
    return useWorktreeSetups((s) => (messageId ? s.setups[messageId] : undefined));
}
