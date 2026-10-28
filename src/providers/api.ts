import { invoke } from "@tauri-apps/api/core";
import type {
    HarnessId,
    ProviderStatus,
    SignInMethod,
    SignInStarted
} from "@/proto";
import { isTauri } from "@/lib/platform";

/**
 * Transport for Settings › Providers (`src-tauri/src/providers.rs`). Under a
 * plain `bun run dev` there's no backend: statuses are made up so the page
 * renders, and every action rejects.
 */

const NO_BACKEND = "Needs the Hive app; there's no backend under `bun run dev`.";

function browserStatus(harness: HarnessId): ProviderStatus {
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

const reject = () => Promise.reject(new Error(NO_BACKEND));

export const providersApi = {
    status: (harness: HarnessId): Promise<ProviderStatus> =>
        isTauri
            ? invoke("provider_status", { harness })
            : Promise.resolve(browserStatus(harness)),
    install: (harness: HarnessId): Promise<void> =>
        isTauri ? invoke("provider_install", { harness }) : reject(),
    update: (harness: HarnessId): Promise<void> =>
        isTauri ? invoke("provider_update", { harness }) : reject(),
    signOut: (harness: HarnessId): Promise<void> =>
        isTauri ? invoke("provider_sign_out", { harness }) : reject(),
    signIn: (harness: HarnessId, method: SignInMethod): Promise<SignInStarted> =>
        isTauri ? invoke("provider_sign_in", { harness, method }) : reject(),
    finishSignIn: (loginId: string, code: string): Promise<void> =>
        isTauri ? invoke("provider_finish_sign_in", { loginId, code }) : reject(),
    cancelSignIn: (loginId: string): Promise<void> =>
        isTauri ? invoke("provider_cancel_sign_in", { loginId }) : Promise.resolve()
};

/** npm packages that publish each CLI, for the newest-release check. */
const NPM_PACKAGES: Partial<Record<HarnessId, string>> = {
    "claude-code": "@anthropic-ai/claude-code"
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
