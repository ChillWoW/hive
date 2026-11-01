import type {
    HarnessId,
    ProviderStatus,
    ProviderUsage,
    SignInMethod,
    SignInStarted
} from "@/proto";
import { backend } from "@/lib/backend";

/**
 * Transport for Settings › Providers (`src-tauri/src/providers.rs`). Under a
 * plain `bun run dev` there's no backend: statuses are made up so the page
 * renders, and every action rejects.
 */

function browserStatus(harness: HarnessId): ProviderStatus {
    if (harness === "codex") {
        return {
            harness,
            installed: true,
            path: "~/.local/bin/codex",
            version: "0.165.0",
            updateChannel: "latest",
            account: { loggedIn: true, method: "ChatGPT", email: "you@example.com", plan: "plus" },
            canInstall: true,
            canUpdate: true,
            canSignIn: true
        };
    }
    const claude = harness === "claude-code";
    return {
        harness,
        installed: claude || harness === "mock",
        path: claude ? "~/.local/bin/claude" : undefined,
        version: claude ? "2.1.300" : undefined,
        updateChannel: claude ? "latest" : undefined,
        account: claude
            ? { loggedIn: true, method: "claude.ai", email: "you@example.com", plan: "max" }
            : undefined,
        canInstall: claude,
        canUpdate: claude,
        canSignIn: claude
    };
}

/** Made-up usage under `bun run dev`, so the composer's ring renders. */
function browserUsage(harness: HarnessId): ProviderUsage | null {
    if (harness !== "claude-code") return null;
    const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    return {
        windows: [
            { label: "Session", used: 0.22, resetsAt: at(2.3) },
            { label: "Week", used: 0.15, resetsAt: at(110) },
            { label: "Week · Opus", used: 0.04, resetsAt: at(110) }
        ]
    };
}

export const providersApi = {
    status: (harness: HarnessId): Promise<ProviderStatus> =>
        backend("provider_status", { harness }, () => browserStatus(harness)),
    /** The signed-in account's plan usage; null when there's none to show. */
    usage: (harness: HarnessId): Promise<ProviderUsage | null> =>
        backend("provider_usage", { harness }, () => browserUsage(harness)),
    install: (harness: HarnessId): Promise<void> => backend("provider_install", { harness }),
    update: (harness: HarnessId): Promise<void> => backend("provider_update", { harness }),
    signOut: (harness: HarnessId): Promise<void> => backend("provider_sign_out", { harness }),
    signIn: (harness: HarnessId, method: SignInMethod): Promise<SignInStarted> =>
        backend("provider_sign_in", { harness, method }),
    finishSignIn: (loginId: string, code: string): Promise<void> =>
        backend("provider_finish_sign_in", { loginId, code }),
    cancelSignIn: (loginId: string): Promise<void> =>
        backend("provider_cancel_sign_in", { loginId }, () => undefined)
};

/** npm packages that publish each CLI, for the newest-release check. */
const NPM_PACKAGES: Partial<Record<HarnessId, string>> = {
    "claude-code": "@anthropic-ai/claude-code",
    codex: "@openai/codex",
    opencode: "@opencode/cli"
};

/** The newest release on `channel` (an npm dist-tag); undefined if the harness has no such check. */
export async function latestRelease(
    harness: HarnessId,
    channel: string
): Promise<string | undefined> {
    const pkg = NPM_PACKAGES[harness];
    if (!pkg) return undefined;
    const response = await fetch(
        `https://registry.npmjs.org/${pkg}/${encodeURIComponent(channel)}`
    );
    if (!response.ok) throw new Error(`npm registry: ${response.status}`);
    const manifest = (await response.json()) as { version?: unknown };
    if (typeof manifest.version !== "string") throw new Error("npm registry: no version");
    return manifest.version;
}

/** Numeric dotted versions; a missing part counts as 0, a pre-release tag is ignored. */
export function isNewer(candidate: string, current: string): boolean {
    const parts = (v: string) =>
        v.split("-")[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
    const a = parts(candidate);
    const b = parts(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}
