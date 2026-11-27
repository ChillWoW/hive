import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PLAN_LABELS, resetsIn, TONE_BG, USAGE_FRESH_MS, usageTone } from "@/features/claude/usage";
import { availableUpdate, type Provider } from "@/features/providers/makeProvider";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/platform";
import { Button, Input, Tooltip } from "@/ui";
import { SettingRow, SettingsSection, SwitchRow } from "../SettingsSection";
import { useSetting } from "../store";

/**
 * Who is signed in, with sign in / sign out. Signing in opens the browser;
 * should it not, the page it names finishes it (for Claude, by showing a
 * code to paste here).
 */
export function AccountSection({ provider, label }: { provider: Provider; label: string }) {
    const status = provider.useProvider((s) => s.status);
    const action = provider.useProvider((s) => s.action);
    const signIn = provider.useProvider((s) => s.signIn);
    const { actions } = provider;
    const [code, setCode] = useState("");
    if (!status?.installed) return null;
    const account = status.account;
    // Personal accounts get an auto-named "<email>'s Organization"; only show a real one.
    const org = account?.organization && account.organization !== `${account.email}'s Organization` ? account.organization : null;
    const line = account?.loggedIn
        ? [account.email, account.plan && `${PLAN_LABELS[account.plan] ?? account.plan} plan`, org]
              .filter(Boolean)
              .join(" · ") || "Signed in"
        : (status.error && !account ? status.error : "Signed out");

    return (
        <SettingsSection title="Account">
            <SettingRow
                label={label}
                keywords="sign in sign out login logout account email plan subscription"
                description={line}
                controlClassName="w-auto"
                control={
                    account?.loggedIn ? (
                        <Button
                            variant="secondary"
                            size="xs"
                            loading={action === "signing-out"}
                            onClick={() => void actions.signOut()}
                        >
                            Sign out
                        </Button>
                    ) : (
                        <Button size="xs" loading={action === "signing-in"} onClick={() => void actions.signIn()}>
                            Sign in
                        </Button>
                    )
                }
            />
            {signIn && (
                <div data-setting-row className="relative flex flex-col gap-2 border-t border-border px-4 py-3">
                    <span className="text-xs text-muted">
                        {actions.submitCode
                            ? "Finish signing in in your browser. If it didn't open, open the sign-in page and paste the code it shows."
                            : "Finish signing in in your browser. If it didn't open, open the sign-in page."}
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
                        {actions.submitCode && (
                            <>
                                <Input
                                    size="xs"
                                    value={code}
                                    placeholder="Paste the code"
                                    aria-label="Sign-in code"
                                    onChange={(e) => setCode(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" && code.trim()) void actions.submitCode?.(code);
                                    }}
                                    className="flex-1"
                                />
                                <Button size="xs" disabled={!code.trim()} onClick={() => void actions.submitCode?.(code)}>
                                    Submit
                                </Button>
                            </>
                        )}
                        <Button variant="ghost" size="xs" className="ml-auto" onClick={actions.cancelSignIn}>
                            Cancel
                        </Button>
                    </div>
                </div>
            )}
        </SettingsSection>
    );
}

/** Where the CLI is and which version, with an update when npm has a newer one. */
export function LocationRow({ provider }: { provider: Provider }) {
    const state = provider.useProvider();
    const { status, latest, action } = state;
    const newer = availableUpdate(state);
    return (
        <SettingRow
            label="Location"
            keywords="cli version install update path location"
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
                    <Button size="xs" loading={action === "updating"} onClick={() => void provider.actions.update()}>
                        Update to v{newer}
                    </Button>
                ) : (
                    <span className="text-xs text-muted">{status?.installed && latest ? "Up to date" : ""}</span>
                )
            }
        />
    );
}

/**
 * How much of the plan's limits is used: one bar per window, and whether
 * the dock shows it (`dock`: whose setting that is).
 */
export function UsageSection({
    provider,
    signedOutHint,
    dock
}: {
    provider: Provider;
    signedOutHint: string;
    dock: "claude" | "codex" | "antigravity";
}) {
    const usage = provider.useUsage((s) => s.windows);
    const error = provider.useUsage((s) => s.error);
    const loading = provider.useUsage((s) => s.loading);
    const { refreshUsage } = provider;
    useEffect(() => {
        void refreshUsage({ maxAge: USAGE_FRESH_MS });
    }, [refreshUsage]);
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
                        error ?? (usage === null ? signedOutHint : "Checking…")
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
            <DockRow section={dock} />
        </SettingsSection>
    );
}

function DockRow({ section }: { section: "claude" | "codex" | "antigravity" }) {
    const inDock = useSetting(section, "showUsageInDock");
    return (
        <SwitchRow
            label="Show in dock"
            description="A ring above Settings; rest on it for every limit"
            keywords="usage dock ring sidebar limits plan show"
            setting={inDock}
        />
    );
}
