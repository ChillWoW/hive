import type { ProviderStatus, SignInStarted, UsageWindow } from "@/proto";
import { backend } from "@/lib/backend";

/** The stand-in for `bun run dev`: installed, signed in, a little used. */
const DEV_STATUS: ProviderStatus = {
    installed: true,
    path: "C:\\Users\\dev\\.local\\bin\\claude.exe",
    version: "2.1.332",
    account: { loggedIn: true, method: "claude.ai", email: "dev@example.com", plan: "max" }
};

const DEV_USAGE: UsageWindow[] = [
    { label: "Session", used: 0.42, resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
    { label: "Week", used: 0.18, resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
    { label: "Week · Opus", used: 0.07 }
];

/** Claude Code as a provider: the one way the UI reaches its CLI outside chats. */
export const claudeApi = {
    status: () => backend<ProviderStatus>("claude_status", {}, () => DEV_STATUS),
    /** The CLI opens the browser; `url` is the fallback page showing a code. */
    startSignIn: () =>
        backend<SignInStarted>("claude_sign_in_start", {}, () => ({ url: "https://claude.ai/oauth/authorize" })),
    /** Resolves once the sign-in in progress finishes (or fails). */
    waitSignIn: () => backend<void>("claude_sign_in_wait", {}, () => new Promise((r) => setTimeout(r, 1500))),
    submitCode: (code: string) => backend<void>("claude_sign_in_code", { code }, () => undefined),
    cancelSignIn: () => backend<void>("claude_sign_in_cancel", {}, () => undefined),
    signOut: () => backend<void>("claude_sign_out", {}, () => undefined),
    update: () => backend<void>("claude_update", {}, () => undefined),
    install: () => backend<void>("claude_install", {}, () => undefined),
    latestVersion: () => backend<string>("claude_latest_version", {}, () => "2.1.340"),
    /** The plan's rate-limit windows; null without a subscription login. */
    usage: () => backend<UsageWindow[] | null>("claude_usage", {}, () => DEV_USAGE)
};
