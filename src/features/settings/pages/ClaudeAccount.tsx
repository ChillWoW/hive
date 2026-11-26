import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { availableUpdate, claudeProvider, useClaudeProvider } from "@/features/claude/store";
import {
    PLAN_LABELS,
    refreshUsage,
    resetsIn,
    TONE_BG,
    USAGE_FRESH_MS,
    useClaudeUsage,
    usageTone
} from "@/features/claude/usage";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { Button, Input, Tooltip } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";

/**
 * Who is signed in to Claude, with sign in / sign out. Signing in runs the
 * CLI's own flow: it opens the browser; should it not, the page it names
 * shows a code to paste here.
 */
export function AccountSection() {
    const status = useClaudeProvider((s) => s.status);
    const action = useClaudeProvider((s) => s.action);
    const signIn = useClaudeProvider((s) => s.signIn);
    const [code, setCode] = useState("");
    if (!status?.installed) return null;
    const account = status.account;
    const line = account?.loggedIn
        ? [account.email, account.plan && `${PLAN_LABELS[account.plan] ?? account.plan} plan`, account.organization]
              .filter(Boolean)
              .join(" · ") || "Signed in"
        : (status.error && !account ? status.error : "Signed out");

    return (
        <SettingsSection title="Account">
            <SettingRow
                label="Claude account"
                keywords="sign in sign out login logout account email plan subscription"
                description={line}
                controlClassName="w-auto"
                control={
                    account?.loggedIn ? (
                        <Button
                            variant="secondary"
                            size="xs"
                            loading={action === "signing-out"}
                            onClick={() => void claudeProvider.signOut()}
                        >
                            Sign out
                        </Button>
                    ) : (
                        <Button size="xs" loading={action === "signing-in"} onClick={() => void claudeProvider.signIn()}>
                            Sign in
                        </Button>
                    )
                }
            />
            {signIn && (
                <div data-setting-row className="relative flex flex-col gap-2 border-t border-border px-4 py-3">
                    <span className="text-xs text-muted">
                        Finish signing in in your browser. If it didn&apos;t open, open the sign-in page and paste the
                        code it shows.
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="secondary"
                            size="xs"
                            onClick={() => (isTauri ? void openUrl(signIn.url) : window.open(signIn.url, "_blank"))}
                        >
                            <ArrowSquareOutIcon />
                            Open page
                        </Button>
                        <Input
                            size="xs"
                            value={code}
                            placeholder="Paste the code"
                            aria-label="Sign-in code"
                            onChange={(e) => setCode(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && code.trim()) void claudeProvider.submitCode(code);
                            }}
                            className="flex-1 font-mono text-xs"
                        />
                        <Button size="xs" disabled={!code.trim()} onClick={() => void claudeProvider.submitCode(code)}>
                            Submit
                        </Button>
                        <Button variant="ghost" size="xs" onClick={claudeProvider.cancelSignIn}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </SettingsSection>
    );
}

/** Where the CLI is and which version, with an update when npm has a newer one. */
export function LocationRow() {
    const provider = useClaudeProvider();
    const { status, latest, action } = provider;
    const newer = availableUpdate(provider);
    return (
        <SettingRow
            label="Location"
            keywords="claude code cli version install update path location"
            description={
                !status
                    ? "Checking…"
                    : !status.installed
                      ? "Not installed"
                      : [status.version && `v${status.version}`, status.path].filter(Boolean).join(" · ")
            }
            controlClassName="w-auto"
            control={
                newer ? (
                    <Button size="xs" loading={action === "updating"} onClick={() => void claudeProvider.update()}>
                        Update to v{newer}
                    </Button>
                ) : (
                    <span className="text-xs text-muted">{status?.installed && latest ? "Up to date" : ""}</span>
                )
            }
        />
    );
}

/** How much of the plan's limits is used: one bar per window, and whether the dock shows it. */
export function UsageSection() {
    const usage = useClaudeUsage((s) => s.windows);
    const error = useClaudeUsage((s) => s.error);
    const loading = useClaudeUsage((s) => s.loading);
    const inDock = useSetting("claude", "showUsageInDock");
    useEffect(() => {
        void refreshUsage({ maxAge: USAGE_FRESH_MS });
    }, []);
    const load = () => refreshUsage();

    return (
        <SettingsSection
            title="Plan usage"
            action={
                <Tooltip>
                    <Tooltip.Trigger
                        render={
                            <Button variant="ghost" size="icon-xs" aria-label="Refresh usage" loading={loading} onClick={() => void load()}>
                                <ArrowClockwiseIcon />
                            </Button>
                        }
                    />
                    <Tooltip.Content side="top">Refresh</Tooltip.Content>
                </Tooltip>
            }
        >
            {error || usage === null || usage === undefined ? (
                <SettingRow
                    label="Usage"
                    keywords="usage limits rate plan session weekly"
                    description={
                        error ?? (usage === null ? "Shown for a Claude subscription login" : "Checking…")
                    }
                    control={null}
                />
            ) : (
                usage.map((window) => {
                    const percent = Math.round(window.used * 100);
                    return (
                        <SettingRow
                            key={window.label}
                            label={window.label}
                            keywords="usage limits rate plan session weekly"
                            description={resetsIn(window.resetsAt)}
                            controlClassName="w-56 gap-2.5"
                            control={
                                <>
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                                        <div
                                            className={cn(
                                                "h-full rounded-full transition-[width] duration-300",
                                                TONE_BG[usageTone(window.used)]
                                            )}
                                            style={{ width: `${Math.min(percent, 100)}%` }}
                                        />
                                    </div>
                                    <span className="w-9 text-right text-xs text-muted tabular-nums">{percent}%</span>
                                </>
                            }
                        />
                    );
                })
            )}
            <SwitchRow
                label="Show in dock"
                description="A ring above Settings; rest on it for every limit"
                keywords="usage dock ring sidebar limits plan show"
                setting={inDock}
            />
        </SettingsSection>
    );
}
