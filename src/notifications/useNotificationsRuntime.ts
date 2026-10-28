import { useEffect } from "react";
import {
    isPermissionGranted,
    requestPermission,
    sendNotification
} from "@tauri-apps/plugin-notification";
import { isUnseen, useChatsStore } from "@/chats";
import { folderName } from "@/composer";
import { isTauri } from "@/lib/platform";
import type { SessionStatus } from "@/proto";
import { settings, useSettingsStore } from "@/settings";
import { setBadge } from "./badge";
import { playChime, unlockAudio } from "./sound";

/**
 * Notifications, the question chime and the unseen-chats badge, all driven by
 * the chat list watch. Mount once, at the root.
 */
export function useNotificationsRuntime() {
    useEffect(unlockAudio, []);
    useEffect(watchSessions, []);
    useBadge();
}

type Change = "finished" | "failed" | "input";

/** What a session's status change means for the user, if anything. */
function change(
    was: SessionStatus | undefined,
    now: SessionStatus | undefined
): Change | null {
    if (was === now) return null;
    if (now === "awaitingInput") return "input";
    if (was !== "working") return null;
    if (now === "errored") return "failed";
    // A run closed mid-turn ends it too.
    return "finished";
}

/** Notifies on session status changes; returns the unsubscribe. */
function watchSessions() {
    let { sessions: previous, loaded: wasLoaded } = useChatsStore.getState();
    return useChatsStore.subscribe(({ sessions, loaded }) => {
        if (sessions === previous) return;
        const before = previous;
        const initial = !wasLoaded;
        previous = sessions;
        wasLoaded = loaded;
        // The first snapshot is the state at launch, not news.
        if (initial) return;

        for (const chatId of new Set([...Object.keys(before), ...Object.keys(sessions)])) {
            const what = change(before[chatId]?.status, sessions[chatId]?.status);
            if (what) void announce(chatId, what);
        }
    });
}

const BODY: Record<Change, string> = {
    finished: "Finished",
    failed: "Stopped with an error",
    input: "Needs your input"
};

async function announce(chatId: string, what: Change) {
    const prefs = settings.get().notifications;
    if (what === "input") {
        if (prefs.inputSound) playChime("input");
    } else if (prefs.finishedSound) {
        playChime("finished");
    }

    const wanted = what === "input" ? prefs.needsInput : prefs.turnFinished;
    if (!wanted || !isTauri || document.hasFocus()) return;
    const chat = useChatsStore.getState().chats.find((c) => c.id === chatId);
    if (!chat) return;
    try {
        if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") {
            return;
        }
        sendNotification({
            title: chat.title ?? folderName(chat.cwd),
            body: BODY[what]
        });
    } catch (error) {
        console.warn("[notifications] notify failed", error);
    }
}

/** Unseen chats on the taskbar / dock icon; archived ones don't count. */
function useBadge() {
    const enabled = useSettingsStore((s) => s.settings.notifications.badge);
    const count = useChatsStore(
        (s) => s.chats.filter((c) => !c.archived && isUnseen(c)).length
    );
    useEffect(() => setBadge(enabled ? count : 0), [enabled, count]);
}
