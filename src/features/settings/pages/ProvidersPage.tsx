import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { availableUpdate, claudeProvider, refreshClaude, useClaudeProvider } from "@/features/claude/store";
import { ClaudeMark } from "@/features/models/ClaudeMark";
import { cn } from "@/lib/cn";
import { Button, IconButton, Skeleton, Tooltip } from "@/ui";
import { ClaudeSettings } from "./ClaudeSettings";

type Tone = "success" | "warning" | "info" | "muted";

const TONES: Record<Tone, { dot: string; pill: string }> = {
    success: { dot: "bg-success", pill: "bg-success/10 text-success" },
    warning: { dot: "bg-warning", pill: "bg-warning/10 text-warning" },
    info: { dot: "bg-info", pill: "bg-info/10 text-info" },
    muted: { dot: "bg-muted", pill: "bg-hover text-muted" }
};

type State = { label: string; tone: Tone; busy?: boolean };

const PLAN_LABELS: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise" };

/** Claude Code's state in a word or two, most pressing first. */
function useClaudeState(): State | undefined {
    const provider = useClaudeProvider();
    const { status, action } = provider;
    if (action === "installing") return { label: "Installing…", tone: "info", busy: true };
    if (action === "updating") return { label: "Updating…", tone: "info", busy: true };
    if (action === "signing-in") return { label: "Signing in…", tone: "info", busy: true };
    if (action === "signing-out") return { label: "Signing out…", tone: "info", busy: true };
    if (!status) return undefined;
    if (!status.installed) return { label: "Not installed", tone: "muted" };
    if (status.account && !status.account.loggedIn) return { label: "Not signed in", tone: "warning" };
    if (availableUpdate(provider)) return { label: "Update available", tone: "info" };
    return { label: "Ready", tone: "success" };
}

/**
 * Settings › Providers: the coding agents as a strip of tabs on top (Claude
 * Code for now), each with its state at a glance; under it the picked one's
 * header, with the one thing to do next, and its settings.
 */
export function ProvidersPage() {
    useEffect(() => {
        void refreshClaude();
    }, []);

    return (
        <>
            <div className="flex flex-col gap-2.5">
                <div className="flex min-h-6 items-center gap-2 px-1">
                    <h3 className="min-w-0 flex-1 text-[13px] font-medium text-text">Coding agents</h3>
                    <RefreshButton />
                </div>
                <div role="tablist" aria-label="Coding agents" className="flex flex-wrap gap-1 rounded-lg bg-surface p-1">
                    <ProviderTab />
                </div>
            </div>
            <div role="tabpanel" className="flex flex-col gap-7">
                <ProviderHeader />
                <ClaudeSettings />
            </div>
        </>
    );
}

function ProviderTab() {
    const state = useClaudeState();
    const version = useClaudeProvider((s) => (s.status?.installed ? s.status.version : undefined));
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        role="tab"
                        aria-selected
                        className="flex h-8 min-w-0 items-center gap-2 rounded-md bg-hover pr-3 pl-2 text-xs text-text shadow-sm shadow-black/30 outline-none"
                    >
                        <span className="relative flex size-5 shrink-0 items-center justify-center">
                            <ClaudeMark className="size-4" />
                            {state && state.tone !== "muted" && (
                                <span
                                    aria-hidden
                                    className={cn(
                                        "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-hover",
                                        TONES[state.tone].dot,
                                        state.busy && "animate-pulse"
                                    )}
                                />
                            )}
                        </span>
                        <span className="truncate font-medium">Claude Code</span>
                    </button>
                }
            />
            <Tooltip.Content side="bottom">
                {[state?.label ?? "Checking…", version && `v${version}`].filter(Boolean).join(" · ")}
            </Tooltip.Content>
        </Tooltip>
    );
}

function RefreshButton() {
    const [busy, setBusy] = useState(false);
    return (
        <IconButton
            label="Check for agents and updates"
            side="left"
            disabled={busy}
            onClick={() => {
                setBusy(true);
                void refreshClaude().finally(() => setBusy(false));
            }}
        >
            <ArrowClockwiseIcon className={cn("size-3.5", busy && "animate-spin")} />
        </IconButton>
    );
}

/** The picked provider: name, state, what runs, and the one thing to do next. */
function ProviderHeader() {
    const provider = useClaudeProvider();
    const { status, action } = provider;
    const state = useClaudeState();
    const newer = availableUpdate(provider);

    const summary = (() => {
        if (!status) return undefined;
        if (!status.installed) return "Install the claude CLI, or point Installation › Claude binary at one";
        const account = status.account;
        const login = account?.loggedIn
            ? `Signed in${account.plan ? ` · ${PLAN_LABELS[account.plan] ?? account.plan} plan` : ""}`
            : account
              ? "Sign in to start chats with Claude"
              : status.error
                ? "Couldn't check the login"
                : undefined;
        return ["claude CLI", status.version && `v${status.version}`, login].filter(Boolean).join(" · ");
    })();

    const next = (() => {
        if (!status) return null;
        if (!status.installed) {
            return (
                <Button size="md" loading={action === "installing"} onClick={() => void claudeProvider.install()}>
                    Install Claude Code
                </Button>
            );
        }
        if (status.account && !status.account.loggedIn) {
            return (
                <Button size="md" loading={action === "signing-in"} onClick={() => void claudeProvider.signIn()}>
                    Sign in
                </Button>
            );
        }
        if (newer) {
            return (
                <Button size="md" loading={action === "updating"} onClick={() => void claudeProvider.update()}>
                    Update to v{newer}
                </Button>
            );
        }
        return null;
    })();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4 rounded-md bg-surface px-4 py-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-raised">
                    <ClaudeMark className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-[15px] leading-5 font-semibold text-text">Claude Code</h3>
                        {state && (
                            <span
                                className={cn(
                                    "flex shrink-0 items-center gap-1 rounded-full px-2 py-px text-[11px] leading-4",
                                    TONES[state.tone].pill
                                )}
                            >
                                {state.busy && <CircleNotchIcon weight="bold" className="size-2.5 animate-spin" />}
                                {state.label}
                            </span>
                        )}
                    </div>
                    {summary ? (
                        <p className="truncate text-xs leading-4 text-muted">{summary}</p>
                    ) : (
                        !status && <Skeleton className="h-3 w-40" />
                    )}
                </div>
                {next}
            </div>
            {status?.error && status.installed && (
                <p className="flex items-start gap-1.5 px-1 text-[11px] leading-4 text-warning">
                    <WarningCircleIcon className="mt-px size-3 shrink-0" />
                    <span className="min-w-0 break-words">{status.error}</span>
                </p>
            )}
        </div>
    );
}
