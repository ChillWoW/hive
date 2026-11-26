import { create } from "zustand";
import type { ProviderStatus } from "@/proto";
import { toast } from "@/ui";
import { claudeApi } from "./api";

type Action = "installing" | "updating" | "signing-in" | "signing-out";

type ClaudeProviderState = {
    /** Undefined until first checked. */
    status?: ProviderStatus;
    /** The newest release on npm, once known. */
    latest?: string;
    /** What's being done to it now. */
    action?: Action;
    /** A sign-in in progress: the page that finishes it if the browser didn't open. */
    signIn?: { url: string };
};

export const useClaudeProvider = create<ClaudeProviderState>()(() => ({}));

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
export function availableUpdate(state: ClaudeProviderState): string | undefined {
    const { status, latest } = state;
    return status?.installed && status.version && latest && older(status.version, latest) ? latest : undefined;
}

/** The installed CLI, its login and the newest release, read again. */
export async function refreshClaude() {
    const [status, latest] = await Promise.allSettled([claudeApi.status(), claudeApi.latestVersion()]);
    useClaudeProvider.setState({
        ...(status.status === "fulfilled" ? { status: status.value } : {}),
        ...(latest.status === "fulfilled" ? { latest: latest.value } : {})
    });
}

/** Runs `run` as `action`, toasting how it went, then reads the status again. */
async function act(action: Action, run: () => Promise<void>, done: string) {
    useClaudeProvider.setState({ action });
    try {
        await run();
        toast.success({ title: done });
    } catch (error) {
        const text = message(error);
        if (!/cancel/i.test(text)) toast.error({ title: "Claude Code", description: text });
    } finally {
        useClaudeProvider.setState({ action: undefined, signIn: undefined });
        await refreshClaude();
    }
}

export const claudeProvider = {
    install: () => act("installing", claudeApi.install, "Claude Code installed"),
    update: () => act("updating", claudeApi.update, "Claude Code updated"),
    signOut: () => act("signing-out", claudeApi.signOut, "Signed out of Claude"),
    /** The CLI opens the browser; the sign-in ends when it's approved there (or a code is pasted). */
    signIn: () =>
        act(
            "signing-in",
            async () => {
                const started = await claudeApi.startSignIn();
                useClaudeProvider.setState({ signIn: started });
                await claudeApi.waitSignIn();
            },
            "Signed in to Claude"
        ),
    submitCode: async (code: string) => {
        try {
            await claudeApi.submitCode(code);
        } catch (error) {
            toast.error({ title: "Couldn't use that code", description: message(error) });
        }
    },
    cancelSignIn: () => void claudeApi.cancelSignIn()
};
