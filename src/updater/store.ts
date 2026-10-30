import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { save, useDocsStore } from "@/editor/documents";
import { hydrateSettings, useSettingsStore } from "@/settings/store";
import { checkForUpdate, installUpdate, type UpdateInfo } from "./api";

/** How often Hive looks for a release while it's open. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** A window focus checks again once the last check is this old. */
const FOCUS_STALE_MS = 60 * 60 * 1000;

export type UpdateState =
    | { phase: "none" }
    | { phase: "available"; update: UpdateInfo }
    | { phase: "downloading"; update: UpdateInfo; progress?: number }
    | { phase: "installing"; update: UpdateInfo }
    | { phase: "failed"; update: UpdateInfo; error: string };

export const useUpdaterStore = create<{
    state: UpdateState;
    /** When the last check started; 0 before the first. */
    checkedAt: number;
    checking: boolean;
    /** Why the last check failed; cleared by the next one that doesn't. */
    error: string | null;
}>()(() => ({
    state: { phase: "none" },
    checkedAt: 0,
    checking: false,
    error: null
}));

const set = (state: UpdateState) => useUpdaterStore.setState({ state });

const busy = () => {
    const { phase } = useUpdaterStore.getState().state;
    return phase === "downloading" || phase === "installing";
};

/** Only the newest check's answer counts (a channel switch starts another). */
let latestCheck = 0;

/** Looks for a newer release. A failed check keeps what the last one found. */
export async function checkNow() {
    if (busy()) return;
    const id = ++latestCheck;
    useUpdaterStore.setState({ checkedAt: Date.now(), checking: true });
    try {
        const update = await checkForUpdate();
        if (id !== latestCheck) return;
        useUpdaterStore.setState({ checking: false, error: null });
        if (busy()) return;
        set(update ? { phase: "available", update } : { phase: "none" });
    } catch (e) {
        if (id !== latestCheck) return;
        console.warn("update check failed:", e);
        useUpdaterStore.setState({
            checking: false,
            error: e instanceof Error ? e.message : String(e)
        });
    }
}

/** Unsaved editor tabs are saved first; one that can't be stops the update. */
async function saveOpenFiles(): Promise<string | null> {
    const docs = Object.entries(useDocsStore.getState().docs).filter(([, d]) => d.dirty);
    for (const [id, doc] of docs) {
        if (!(await save(id))) return `Couldn't save ${doc.path}. Save or close it first.`;
    }
    return null;
}

/** Downloads, installs and restarts. Agents and terminals are stopped. */
export async function install() {
    const { state } = useUpdaterStore.getState();
    if (state.phase !== "available" && state.phase !== "failed") return;
    const { update } = state;
    const unsaved = await saveOpenFiles();
    if (unsaved) {
        set({ phase: "failed", update, error: unsaved });
        return;
    }
    set({ phase: "downloading", update });
    try {
        await installUpdate((p) => {
            if (p.kind === "installing") set({ phase: "installing", update });
            else if (p.total) set({ phase: "downloading", update, progress: p.downloaded / p.total });
        });
    } catch (e) {
        set({ phase: "failed", update, error: e instanceof Error ? e.message : String(e) });
    }
}

/**
 * Mounted in `App`. With `updates.autoCheck` on: checks at launch (once the
 * settings file is read), every few hours and on window focus. A channel
 * switch checks again either way.
 */
export function useUpdaterRuntime() {
    const [ready, setReady] = useState(false);
    const autoCheck = useSettingsStore((s) => s.settings.updates.autoCheck);
    const channel = useSettingsStore((s) => s.settings.updates.channel);
    const lastChannel = useRef(channel);

    useEffect(() => {
        let live = true;
        void hydrateSettings().then(() => {
            if (live) setReady(true);
        });
        return () => {
            live = false;
        };
    }, []);

    useEffect(() => {
        if (!ready || !autoCheck) return;
        void checkNow();
        const timer = window.setInterval(() => void checkNow(), CHECK_EVERY_MS);
        const onFocus = () => {
            if (Date.now() - useUpdaterStore.getState().checkedAt > FOCUS_STALE_MS) {
                void checkNow();
            }
        };
        window.addEventListener("focus", onFocus);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", onFocus);
        };
    }, [ready, autoCheck]);

    useEffect(() => {
        if (!ready) {
            lastChannel.current = channel;
            return;
        }
        if (lastChannel.current === channel) return;
        lastChannel.current = channel;
        void checkNow();
    }, [ready, channel]);
}
