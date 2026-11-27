import type { ProviderStatus, SignInStarted, UsageWindow } from "@/proto";
import { devUsage } from "@/features/providers/devUsage";
import { backend } from "@/lib/backend";
import type { ProviderApi } from "@/features/providers/makeProvider";

/** The stand-in for `bun run dev`: installed, signed in with ChatGPT, a little used. */
const DEV_STATUS: ProviderStatus = {
    installed: true,
    path: "C:\\Users\\dev\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    version: "0.167.1",
    account: { loggedIn: true, method: "ChatGPT", email: "dev@example.com", plan: "plus" }
};

const DEV_USAGE: UsageWindow[] = [
    { label: "5 hours", used: 0.22, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    { label: "Week", used: 0.09, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }
];

/** Codex as a provider (`src-tauri/src/codex.rs`). Sign-in is ChatGPT's browser flow; nothing to paste. */
export const codexApi: ProviderApi = {
    status: () => backend<ProviderStatus>("codex_status", {}, () => DEV_STATUS),
    startSignIn: () =>
        backend<SignInStarted>("codex_sign_in_start", {}, () => ({ url: "https://auth.openai.com/oauth/authorize" })),
    waitSignIn: () => backend<void>("codex_sign_in_wait", {}, () => new Promise((r) => setTimeout(r, 1500))),
    cancelSignIn: () => backend<void>("codex_sign_in_cancel", {}, () => undefined),
    signOut: () => backend<void>("codex_sign_out", {}, () => undefined),
    update: () => backend<void>("codex_update", {}, () => undefined),
    install: () => backend<void>("codex_install", {}, () => undefined),
    latestVersion: () => backend<string>("codex_latest_version", {}, () => "0.167.1"),
    usage: () => backend<UsageWindow[] | null>("codex_usage", {}, () => devUsage(DEV_USAGE))
};
