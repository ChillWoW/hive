import { useEffect, useState } from "react";
import { ArrowClockwiseIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { HarnessId } from "@/proto";
import { claude } from "@/features/claude/store";
import { PLAN_LABELS } from "@/features/claude/usage";
import { codex } from "@/features/codex/store";
import { HarnessMark } from "@/features/models";
import { availableUpdate, type Provider } from "@/features/providers/makeProvider";
import { cn } from "@/lib/cn";
import { Button, IconButton, Skeleton, Tooltip } from "@/ui";
import { ClaudeSettings } from "./ClaudeSettings";
import { CodexSettings } from "./CodexSettings";

type Tone = "success" | "warning" | "info" | "muted";

const TONES: Record<Tone, { dot: string; pill: string }> = {
    success: { dot: "bg-success", pill: "bg-success/10 text-success" },
    warning: { dot: "bg-warning", pill: "bg-warning/10 text-warning" },
    info: { dot: "bg-info", pill: "bg-info/10 text-info" },
    muted: { dot: "bg-muted", pill: "bg-hover text-muted" }
};

type State = { label: string; tone: Tone; busy?: boolean };

/** A coding agent on the page: its provider, how it's named, and its settings. */
type Agent = {
    id: HarnessId;
    provider: Provider;
    /** The CLI's command, as the header names it. */
    cli: string;
    notInstalled: string;
    signedOut: string;
    Settings: () => React.ReactNode;
};

const AGENTS: Agent[] = [
    {
        id: "claude",
        provider: claude,
        cli: "claude",
        notInstalled: "Install the claude CLI, or point Installation › Claude binary at one",
        signedOut: "Sign in to start chats with Claude",
        Settings: ClaudeSettings
    },
    {
        id: "codex",
        provider: codex,
        cli: "codex",
        notInstalled: "Install the codex CLI to start chats with Codex",
        signedOut: "Sign in with ChatGPT to start chats with Codex",
        Settings: CodexSettings
    }
];

const refreshAll = () => Promise.all(AGENTS.map((a) => a.provider.refresh()));

/** An agent's state in a word or two, most pressing first. */
function useAgentState(provider: Provider): State | undefined {
    const state = provider.useProvider();
    const { status, action } = state;
    if (action === "installing") return { label: "Installing…", tone: "info", busy: true };
    if (action === "updating") return { label: "Updating…", tone: "info", busy: true };
    if (action === "signing-in") return { label: "Signing in…", tone: "info", busy: true };
    if (action === "signing-out") return { label: "Signing out…", tone: "info", busy: true };
    if (!status) return undefined;
    if (!status.installed) return { label: "Not installed", tone: "muted" };
    if (status.account && !status.account.loggedIn) return { label: "Not signed in", tone: "warning" };
    if (availableUpdate(state)) return { label: "Update available", tone: "info" };
    return { label: "Ready", tone: "success" };
}

/**
 * Settings › Providers: the coding agents as a strip of tabs on top, each
 * with its state at a glance; under it the picked one's header, with the one
 * thing to do next, and its settings.
 */
export function ProvidersPage() {
    const [picked, setPicked] = useState<HarnessId>("claude");
    const agent = AGENTS.find((a) => a.id === picked) ?? AGENTS[0];
    useEffect(() => {
        void refreshAll();
    }, []);

    return (
        <>
            <div className="flex flex-col gap-2.5">
                <div className="flex min-h-6 items-center gap-2 px-1">
                    <h3 className="min-w-0 flex-1 text-[13px] font-medium text-text">Coding agents</h3>
                    <RefreshButton />
                </div>
                <div role="tablist" aria-label="Coding agents" className="flex flex-wrap gap-1 rounded-lg bg-surface p-1">
                    {AGENTS.map((a) => (
                        <ProviderTab key={a.id} agent={a} selected={a.id === picked} onSelect={() => setPicked(a.id)} />
                    ))}
                </div>
            </div>
            <div role="tabpanel" className="flex flex-col gap-7">
                <ProviderHeader key={agent.id} agent={agent} />
                <agent.Settings />
            </div>
        </>
    );
}

function ProviderTab({ agent, selected, onSelect }: { agent: Agent; selected: boolean; onSelect: () => void }) {
    const state = useAgentState(agent.provider);
    const version = agent.provider.useProvider((s) => (s.status?.installed ? s.status.version : undefined));
    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={onSelect}
                        className={cn(
                            "flex h-8 min-w-0 items-center gap-2 rounded-md pr-3 pl-2 text-xs outline-none",
                            "transition-colors duration-150",
                            selected
                                ? "bg-hover text-text shadow-sm shadow-shadow/30"
                                : "text-muted hover:bg-raised hover:text-text"
                        )}
                    >
                        <span className="relative flex size-5 shrink-0 items-center justify-center">
                            <HarnessMark harness={agent.id} className="size-4" />
                            {state && state.tone !== "muted" && (
                                <span
                                    aria-hidden
                                    className={cn(
                                        "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2",
                                        selected ? "ring-hover" : "ring-surface",
                                        TONES[state.tone].dot,
                                        state.busy && "animate-pulse"
                                    )}
                                />
                            )}
                        </span>
                        <span className="truncate font-medium">{agent.provider.name}</span>
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
                void refreshAll().finally(() => setBusy(false));
            }}
        >
            <ArrowClockwiseIcon className={cn("size-3.5", busy && "animate-spin")} />
        </IconButton>
    );
}

/** The picked agent: name, state, what runs, and the one thing to do next. */
function ProviderHeader({ agent }: { agent: Agent }) {
    const { provider } = agent;
    const providerState = provider.useProvider();
    const { status, action } = providerState;
    const state = useAgentState(provider);
    const newer = availableUpdate(providerState);

    const summary = (() => {
        if (!status) return undefined;
        if (!status.installed) return agent.notInstalled;
        const account = status.account;
        const login = account?.loggedIn
            ? `Signed in${account.plan ? ` · ${PLAN_LABELS[account.plan] ?? account.plan} plan` : ""}`
            : account
              ? agent.signedOut
              : status.error
                ? "Couldn't check the login"
                : undefined;
        return [`${agent.cli} CLI`, status.version && `v${status.version}`, login].filter(Boolean).join(" · ");
    })();

    const next = (() => {
        if (!status) return null;
        if (!status.installed) {
            return (
                <Button size="md" loading={action === "installing"} onClick={() => void provider.actions.install()}>
                    Install {provider.name}
                </Button>
            );
        }
        if (status.account && !status.account.loggedIn) {
            return (
                <Button size="md" loading={action === "signing-in"} onClick={() => void provider.actions.signIn()}>
                    Sign in
                </Button>
            );
        }
        if (newer) {
            return (
                <Button size="md" loading={action === "updating"} onClick={() => void provider.actions.update()}>
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
                    <HarnessMark harness={agent.id} className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-[15px] leading-5 font-semibold text-text">{provider.name}</h3>
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
