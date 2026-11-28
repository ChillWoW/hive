import { useEffect } from "react";
import { create } from "zustand";
import { useWorking } from "@/features/chats/store";
import { checkAllOnDisk } from "@/features/editor";
import { gitApi } from "@/features/git/api";
import { git } from "@/features/git/store";
import { errorMessage } from "@/lib/errors";
import { onWindowFocus } from "@/lib/windowFocus";
import type { GitChanges } from "@/proto";
import type { Changed } from "./patchFiles";
import { rereadChanges, type ChangesState } from "./useChanges";

/*
 * What each chat's latest turn changed in its checkout: the engine snapshots
 * the checkout as a prompt starts a turn, and reads the changes since against
 * it. Shared per chat, so the reply's footer and the turn's tab agree.
 */

type Entry = {
    /** Undefined until first read; null when no turn is recorded (none since launch, or outside a checkout). */
    changes: GitChanges | null | undefined;
    error: string | null;
    loading: boolean;
};

const BLANK: Entry = { changes: undefined, error: null, loading: false };

const useTurnStore = create<{ turns: Record<string, Entry> }>()(() => ({ turns: {} }));

function patchEntry(chatId: string, patch: Partial<Entry>) {
    useTurnStore.setState((s) => ({ turns: { ...s.turns, [chatId]: { ...(s.turns[chatId] ?? BLANK), ...patch } } }));
}

/** The read running per chat, and whether something asked for another meanwhile. */
const reads = new Map<string, { again: boolean }>();

/**
 * Reads the chat's turn changes again. One read at a time per chat (each
 * snapshots the checkout): one asked for meanwhile runs after it.
 */
export function refreshTurn(chatId: string) {
    const running = reads.get(chatId);
    if (running) {
        running.again = true;
        return;
    }
    const read = { again: false };
    reads.set(chatId, read);
    patchEntry(chatId, { loading: true });
    gitApi
        .turnChanges(chatId)
        .then(
            (next) => {
                const prev = useTurnStore.getState().turns[chatId]?.changes;
                // The same patch keeps its object, so nothing re-parses.
                const same = prev && next && prev.patch === next.patch && prev.root === next.root;
                patchEntry(chatId, { changes: same ? prev : next, error: null, loading: false });
            },
            (e: unknown) =>
                patchEntry(chatId, { error: errorMessage(e, "Couldn't read the turn's changes."), loading: false })
        )
        .finally(() => {
            reads.delete(chatId);
            if (read.again) refreshTurn(chatId);
        });
}

/**
 * What the chat's latest turn changed, read on mount and again when the
 * window regains focus, a turn of the chat starts or ends, or a `refresh`.
 * Never polled: each read snapshots the whole checkout.
 */
export function useTurnChanges(chatId: string): ChangesState {
    const entry = useTurnStore((s) => s.turns[chatId]) ?? BLANK;
    const working = useWorking(chatId);

    useEffect(() => {
        refreshTurn(chatId);
    }, [chatId, working]);

    useEffect(() => onWindowFocus(() => refreshTurn(chatId)), [chatId]);

    return { ...entry, refresh: () => refreshTurn(chatId) };
}

/** What to undo: a chat's latest turn, whole or some of its files. */
export type RevertRequest = {
    chatId: string;
    /** The chat's folder, whose checkout is read again afterwards. */
    cwd: string;
    files: Changed[];
    /** Every file the turn changed, rather than just `files`. */
    whole: boolean;
};

/** Undoes `request`, then reads again everything that shows those files. */
export async function revertTurn(request: RevertRequest) {
    const paths = request.whole
        ? undefined
        : request.files.flatMap(({ diff }) => (diff.prevName ? [diff.name, diff.prevName] : [diff.name]));
    try {
        await gitApi.revertTurn(request.chatId, paths);
    } finally {
        // A failure may still have put some files back.
        refreshTurn(request.chatId);
        rereadChanges();
        void git.refresh(request.cwd, true);
        checkAllOnDisk();
    }
}
