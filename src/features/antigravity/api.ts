import type { ProviderStatus, SignInStarted, UsageWindow } from "@/proto";
import { backend } from "@/lib/backend";
import type { ProviderApi } from "@/features/providers/makeProvider";

/** The stand-in for `bun run dev`: installed, signed in with Google, a little used. */
const DEV_STATUS: ProviderStatus = {
    installed: true,
    path: "C:\\Users\\dev\\AppData\\Local\\agy\\bin\\agy.exe",
    version: "1.5.18",
    account: { loggedIn: true, method: "Google" }
};

const DEV_USAGE: UsageWindow[] = [
    { label: "Gemini · Week", used: 0.04, resetsAt: new Date(Date.now() + 6 * 86_400_000).toISOString() },
    { label: "Claude & GPT · Week", used: 0 },
    { label: "Claude & GPT · 5 hours", used: 0 }
];

/** Antigravity as a provider (`src-tauri/src/antigravity.rs`). Sign-in is Google's page, which ends on a code to paste. */
export const antigravityApi: ProviderApi = {
    status: () => backend<ProviderStatus>("antigravity_status", {}, () => DEV_STATUS),
    startSignIn: () =>
        backend<SignInStarted>("antigravity_sign_in_start", {}, () => ({
            url: "https://accounts.google.com/o/oauth2/auth"
        })),
    waitSignIn: () => backend<void>("antigravity_sign_in_wait", {}, () => new Promise((r) => setTimeout(r, 1500))),
    submitCode: (code: string) => backend<void>("antigravity_sign_in_code", { code }, () => undefined),
    cancelSignIn: () => backend<void>("antigravity_sign_in_cancel", {}, () => undefined),
    signOut: () => backend<void>("antigravity_sign_out", {}, () => undefined),
    update: () => backend<void>("antigravity_update", {}, () => undefined),
    install: () => backend<void>("antigravity_install", {}, () => undefined),
    latestVersion: () => backend<string>("antigravity_latest_version", {}, () => "1.5.18"),
    usage: () => backend<UsageWindow[] | null>("antigravity_usage", {}, () => DEV_USAGE)
};
