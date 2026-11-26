import { useEffect } from "react";
import { create } from "zustand";
import type { ProviderStatus, SignInStarted, UsageWindow } from "@/proto";
import { onWindowFocus } from "@/lib/windowFocus";
import { toast } from "@/ui";

/** How the UI reaches a coding agent's CLI outside chats. */
export type ProviderApi = {
    status: () => Promise<ProviderStatus>;
    /** Opens the browser; `url` is the fallback page. */
    startSignIn: () => Promise<SignInStarted>;
    /** Resolves once the sign-in in progress finishes (or fails). */
    waitSignIn: () => Promise<void>;
    /** For a flow whose fallback page shows a code to paste (Claude's). */
    submitCode?: (code: string) => Promise<void>;
    cancelSignIn: () => Promise<void>;
    signOut: () => Promise<void>;
    update: () => Promise<void>;
    install: () => Promise<void>;
    /** The newest release on npm. */
    latestVersion: () => Promise<string>;
    /** The plan's rate-limit windows; null without a subscription login. */
    usage: () => Promise<UsageWindow[] | null>;
};

export type ProviderAction = "installing" | "updating" | "signing-in" | "signing-out";

export type ProviderState = {
    /** Undefined until first checked. */
    status?: ProviderStatus;
    /** The newest release on npm, once known. */
    latest?: string;
    /** What's being done to it now. */
    action?: ProviderAction;
    /** A sign-in in progress: the page that finishes it if the browser didn't open. */
    signIn?: { url: string };
};

export type UsageState = {
    /** The plan's windows; null without a subscription login; undefined until first read. */
    windows?: UsageWindow[] | null;
    /** What went wrong on the last read; earlier windows are kept. */
    error?: string;
    loading: boolean;
    /** When the last read finished (ms). */
    checkedAt?: number;
};

/** Reads are cheap but usage endpoints answer 429 when asked too often. */
const POLL_MS = 5 * 60_000;
/** How old a usage read may be before a glance (focus, hover) reads it again. */
export const USAGE_FRESH_MS = 60_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether version `a` is older than `b` (`2.1.9` < `2.1.10`). */
function older(a: string, b: string): boolean {
    const parts = (v: string) => v.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
    }
    return false;
}

/** The newer release to update to, if there is one. */
export function availableUpdate(state: ProviderState): string | undefined {
    const { status, latest } = state;
    return status?.installed && status.version && latest && older(status.version, latest) ? latest : undefined;
}

/**
 * A provider's state and what can be done to it: status and newest release,
 * install / update / sign in / sign out (each toasted as `name`), and its
 * plan usage.
 */
export function makeProvider(name: string, api: ProviderApi) {
    const useProvider = create<ProviderState>()(() => ({}));

    /** The installed CLI, its login and the newest release, read again. */
    async function refresh() {
        const [status, latest] = await Promise.allSettled([api.status(), api.latestVersion()]);
        useProvider.setState({
            ...(status.status === "fulfilled" ? { status: status.value } : {}),
            ...(latest.status === "fulfilled" ? { latest: latest.value } : {})
        });
    }

    /** Runs `run` as `action`, toasting how it went, then reads the status again. */
    async function act(action: ProviderAction, run: () => Promise<void>, done: string) {
        useProvider.setState({ action });
        try {
            await run();
            toast.success({ title: done });
        } catch (error) {
            const text = message(error);
            if (!/cancel/i.test(text)) toast.error({ title: name, description: text });
        } finally {
            useProvider.setState({ action: undefined, signIn: undefined });
            await refresh();
        }
    }

    const actions = {
        install: () => act("installing", api.install, `${name} installed`),
        update: () => act("updating", api.update, `${name} updated`),
        signOut: () => act("signing-out", api.signOut, `Signed out of ${name}`),
        signIn: () =>
            act(
                "signing-in",
                async () => {
                    const started = await api.startSignIn();
                    useProvider.setState({ signIn: started });
                    await api.waitSignIn();
                },
                `Signed in to ${name}`
            ),
        /** Present when the sign-in can take a pasted code. */
        submitCode: api.submitCode
            ? async (code: string) => {
                  try {
                      await api.submitCode?.(code);
                  } catch (error) {
                      toast.error({ title: "Couldn't use that code", description: message(error) });
                  }
              }
            : undefined,
        cancelSignIn: () => void api.cancelSignIn()
    };

    const useUsage = create<UsageState>()(() => ({ loading: false }));
    let inflight: Promise<void> | undefined;

    /** Reads the usage again, unless a read is running or one finished under `maxAge` ms ago. */
    function refreshUsage({ maxAge = 0 }: { maxAge?: number } = {}): Promise<void> {
        if (inflight) return inflight;
        const { checkedAt } = useUsage.getState();
        if (maxAge && checkedAt && Date.now() - checkedAt < maxAge) return Promise.resolve();
        useUsage.setState({ loading: true });
        inflight = api
            .usage()
            .then(
                (windows) => useUsage.setState({ windows, error: undefined }),
                (error: unknown) => useUsage.setState({ error: message(error) })
            )
            .finally(() => {
                useUsage.setState({ loading: false, checkedAt: Date.now() });
                inflight = undefined;
            });
        return inflight;
    }

    /** Keeps the usage fresh while `enabled`: now, every few minutes, and on window focus. */
    function useUsagePolling(enabled: boolean) {
        useEffect(() => {
            if (!enabled) return;
            void refreshUsage({ maxAge: USAGE_FRESH_MS });
            const timer = window.setInterval(() => void refreshUsage(), POLL_MS);
            const off = onWindowFocus(() => void refreshUsage({ maxAge: USAGE_FRESH_MS }));
            return () => {
                window.clearInterval(timer);
                off();
            };
        }, [enabled]);
    }

    return { name, useProvider, refresh, actions, useUsage, refreshUsage, useUsagePolling };
}

export type Provider = ReturnType<typeof makeProvider>;
