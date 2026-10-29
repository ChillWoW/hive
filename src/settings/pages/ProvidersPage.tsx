import { useEffect, useState, type ReactNode } from "react";
import {
    ArrowClockwiseIcon,
    CaretRightIcon,
    CircleNotchIcon,
    WarningCircleIcon,
    XIcon
} from "@phosphor-icons/react";
import {
    HarnessIcon,
    isEnabled,
    providerKey,
    refreshCatalogs,
    useHarnesses,
    useHarnessesStore
} from "@/harnesses";
import { cn } from "@/lib/cn";
import {
    availableUpdate,
    providers,
    refreshProvider,
    useProvider,
    type ProviderEntry
} from "@/providers";
import type { HarnessCatalog, ProviderAccount, ProvidersSettings } from "@/proto";
import { DEFAULT_SETTINGS } from "@/proto";
import { Button, iconButtonClassName, Skeleton, Switch, Tooltip } from "@/ui";
import { CopyButton } from "../CopyButton";
import { matchesQuery, useSettingsQuery } from "../search";
import { SettingsSection } from "../SettingsSection";
import { useSettingsStore } from "../store";
import { SignInDialog } from "./SignInDialog";

/** The CLI each harness runs, for install hints. */
const CLI_NAMES: Partial<Record<HarnessCatalog["id"], string>> = {
    "claude-code": "claude",
    codex: "codex",
    opencode: "opencode"
};

/**
 * One card, a row per harness: its CLI's version and login at a glance, an
 * Install / Update / Sign in action when one is due, and a switch for whether
 * the pickers offer it. A row opens into its account, version and location.
 */
export function ProvidersPage() {
    const harnesses = useHarnesses();
    const loaded = useHarnessesStore((s) => s.loaded);
    const [expanded, setExpanded] = useState<HarnessCatalog["id"] | null>(null);
    const [signingIn, setSigningIn] = useState<HarnessCatalog | null>(null);
    const providersSettings = useSettingsStore((s) => s.settings.providers);

    const ids = harnesses.map((h) => h.id).join(",");
    useEffect(() => {
        void refreshCatalogs();
    }, []);
    useEffect(() => {
        for (const id of ids.split(",").filter(Boolean)) {
            void refreshProvider(id as HarnessCatalog["id"]);
        }
    }, [ids]);

    const enabledCount = harnesses.filter((h) => isEnabled(providersSettings, h.id)).length;

    return (
        <>
            <SettingsSection
                title="Coding agents"
                action={<RefreshButton ids={harnesses.map((h) => h.id)} />}
            >
                {!loaded && harnesses.length === 0 ? (
                    <RowSkeleton />
                ) : (
                    harnesses.map((catalog) => (
                        <ProviderRow
                            key={catalog.id}
                            catalog={catalog}
                            expanded={expanded === catalog.id}
                            onToggle={() =>
                                setExpanded((open) => (open === catalog.id ? null : catalog.id))
                            }
                            lastOn={enabledCount <= 1}
                            onSignIn={() => setSigningIn(catalog)}
                        />
                    ))
                )}
            </SettingsSection>
            <p className="-mt-4 px-1 text-xs leading-4 text-dark-300">
                Hive runs the agent CLIs installed on this computer, signed in with their own
                accounts.
            </p>

            <SignInDialog catalog={signingIn} onClose={() => setSigningIn(null)} />
        </>
    );
}

function RefreshButton({ ids }: { ids: HarnessCatalog["id"][] }) {
    const [busy, setBusy] = useState(false);
    const refresh = async () => {
        setBusy(true);
        try {
            await Promise.all([
                refreshCatalogs(),
                ...ids.map((id) => refreshProvider(id, { force: true }))
            ]);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        aria-label="Check for agents and updates"
                        disabled={busy}
                        onClick={() => void refresh()}
                        className={iconButtonClassName}
                    >
                        <ArrowClockwiseIcon className={cn("size-3.5", busy && "animate-spin")} />
                    </button>
                }
            />
            <Tooltip.Content side="left">Check for agents and updates</Tooltip.Content>
        </Tooltip>
    );
}

function RowSkeleton() {
    return (
        <div data-setting-row className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-9 rounded-[10px]" />
            <div className="flex flex-col gap-1.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-2.5 w-40" />
            </div>
        </div>
    );
}

function ProviderRow({
    catalog,
    expanded,
    onToggle,
    lastOn,
    onSignIn
}: {
    catalog: HarnessCatalog;
    expanded: boolean;
    onToggle: () => void;
    /** It's the only one on, so it can't be turned off. */
    lastOn: boolean;
    onSignIn: () => void;
}) {
    const query = useSettingsQuery();
    const provider = useProvider(catalog.id);
    const providersSettings = useSettingsStore((s) => s.settings.providers);
    const update = useSettingsStore((s) => s.update);
    const { status, action } = provider;

    const key = providerKey(catalog.id) as keyof ProvidersSettings;
    const hasSwitch = key in DEFAULT_SETTINGS.providers;
    const enabled = isEnabled(providersSettings, catalog.id);
    const locked = enabled && lastOn;
    const mock = catalog.id === "mock";
    const installed = status?.installed ?? catalog.installed;
    const hasDetails = installed && !mock && status !== undefined;
    const open = expanded && hasDetails;
    const newer = availableUpdate(provider);
    const account = status?.account;

    const actionButton = (() => {
        // Opened, the details carry the same actions.
        if (!status || mock || open) return null;
        if (!installed) {
            return status.canInstall ? (
                <Button
                    size="sm"
                    variant="primary"
                    loading={action === "installing"}
                    onClick={() => void providers.install(catalog.id)}
                >
                    Install
                </Button>
            ) : null;
        }
        if (newer && status.canUpdate) {
            return (
                <Button
                    size="sm"
                    variant="primary"
                    loading={action === "updating"}
                    onClick={() => void providers.update(catalog.id)}
                >
                    Update
                </Button>
            );
        }
        if (account && !account.loggedIn && status.canSignIn) {
            return (
                <Button size="sm" variant="primary" onClick={onSignIn}>
                    Sign in
                </Button>
            );
        }
        return null;
    })();

    if (
        !matchesQuery(
            query,
            catalog.label,
            "provider providers agent harness cli install update upgrade version sign in login logout account plan path"
        )
    ) {
        return null;
    }

    return (
        <div
            data-setting-row
            className="relative not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-dark-600"
        >
            <div className="flex items-center gap-3 px-4 py-3">
                <button
                    type="button"
                    disabled={!hasDetails}
                    aria-expanded={hasDetails ? open : undefined}
                    onClick={onToggle}
                    className={cn(
                        "-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-md p-1 text-left outline-none",
                        "focus-visible:bg-dark-700/60",
                        !installed && !mock && "opacity-60"
                    )}
                >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-dark-700">
                        <HarnessIcon harness={catalog.id} className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[13px] leading-5 font-medium text-dark-50">
                            {catalog.label}
                        </span>
                        <MetaLine catalog={catalog} provider={provider} newer={newer} />
                    </span>
                </button>

                <div className="flex shrink-0 items-center gap-2">
                    {actionButton}
                    {hasDetails && (
                        <button
                            type="button"
                            aria-label={open ? "Hide details" : "Show details"}
                            onClick={onToggle}
                            className={iconButtonClassName}
                        >
                            <CaretRightIcon
                                weight="bold"
                                className={cn(
                                    "size-3 transition-transform duration-150",
                                    open && "rotate-90"
                                )}
                            />
                        </button>
                    )}
                    {hasSwitch && (
                        <LockedTooltip locked={locked}>
                            <Switch
                                checked={enabled}
                                disabled={locked}
                                onCheckedChange={(on) =>
                                    void update({ providers: { [key]: on } })
                                }
                                aria-label={`Offer ${catalog.label} in new chats`}
                            />
                        </LockedTooltip>
                    )}
                </div>
            </div>

            {provider.error && (
                <ErrorStrip
                    message={provider.error}
                    onDismiss={() => providers.clearError(catalog.id)}
                />
            )}

            {hasDetails && (
                <div
                    className={cn(
                        "grid transition-[grid-template-rows] duration-200 ease-out",
                        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    )}
                    inert={!open}
                >
                    <div className="min-h-0 overflow-hidden">
                        <Details
                            catalog={catalog}
                            provider={provider}
                            newer={newer}
                            onSignIn={onSignIn}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

function LockedTooltip({ locked, children }: { locked: boolean; children: ReactNode }) {
    if (!locked) return <>{children}</>;
    return (
        <Tooltip>
            <Tooltip.Trigger render={<span className="inline-flex">{children}</span>} />
            <Tooltip.Content side="left">At least one agent stays on</Tooltip.Content>
        </Tooltip>
    );
}

/** Under the name: what state the CLI is in, in a few words. */
function MetaLine({
    catalog,
    provider,
    newer
}: {
    catalog: HarnessCatalog;
    provider: ProviderEntry;
    newer: string | undefined;
}) {
    const { status, action } = provider;
    const muted = "text-xs leading-4 text-dark-250";

    if (catalog.id === "mock") {
        return <span className={muted}>Built in · scripted turns for building the UI</span>;
    }
    if (action === "installing") {
        return (
            <span className={cn(muted, "flex items-center gap-1.5")}>
                <CircleNotchIcon weight="bold" className="size-3 animate-spin" />
                Installing {catalog.label}… this can take a minute
            </span>
        );
    }
    if (!status) {
        return <Skeleton className="my-0.5 h-3 w-36" />;
    }
    if (!status.installed) {
        const cli = CLI_NAMES[catalog.id];
        return (
            <span className={muted}>
                {cli ? `Install the ${cli} CLI to use it` : "Not available yet"}
            </span>
        );
    }

    const parts: ReactNode[] = [];
    if (action === "updating") {
        parts.push(
            <span key="v" className="flex items-center gap-1.5">
                <CircleNotchIcon weight="bold" className="size-3 animate-spin" />
                Updating{newer ? ` to v${newer}` : ""}…
            </span>
        );
    } else if (status.version) {
        parts.push(
            <span key="v" className="tabular-nums">
                v{status.version}
                {newer && <span className="text-dark-100"> → v{newer}</span>}
            </span>
        );
    }
    const { account } = status;
    if (account?.loggedIn) {
        parts.push(<span key="a" className="truncate">{account.email ?? "Signed in"}</span>);
    } else if (account) {
        parts.push(<span key="a" className="text-warning">Not signed in</span>);
    } else if (status.error) {
        parts.push(<span key="a" className="text-warning">Couldn't check the login</span>);
    }

    return (
        <span className={cn(muted, "flex min-w-0 items-center gap-1.5")}>
            {parts.map((part, i) => (
                <span key={i} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <span className="text-dark-400">·</span>}
                    {part}
                </span>
            ))}
        </span>
    );
}

function ErrorStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs leading-4 text-danger">
            <WarningCircleIcon className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words whitespace-pre-line">{message}</span>
            <button
                type="button"
                aria-label="Dismiss"
                onClick={onDismiss}
                className="shrink-0 rounded-sm text-danger/70 transition-colors hover:text-danger"
            >
                <XIcon weight="bold" className="size-3" />
            </button>
        </div>
    );
}

const PLAN_LABELS: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    max: "Max",
    team: "Team",
    business: "Business",
    edu: "Edu",
    enterprise: "Enterprise"
};

function methodLabel(method: string | undefined): string | undefined {
    if (!method) return undefined;
    if (method === "claude.ai") return "Claude subscription";
    if (/console/i.test(method)) return "Anthropic Console";
    if (/api.?key/i.test(method)) return "API key";
    if (/oauth.?token/i.test(method)) return "OAuth token";
    return method;
}

function accountMeta(account: ProviderAccount): string {
    const plan = account.plan && (PLAN_LABELS[account.plan] ?? account.plan);
    // The CLI names a personal org after the email; that adds nothing.
    const org =
        account.organization && !account.organization.startsWith(account.email ?? "\0")
            ? account.organization
            : undefined;
    return [plan, methodLabel(account.method), org].filter(Boolean).join(" · ");
}

/** The opened row: account, version, location, laid out as a label column beside values. */
function Details({
    catalog,
    provider,
    newer,
    onSignIn
}: {
    catalog: HarnessCatalog;
    provider: ProviderEntry;
    newer: string | undefined;
    onSignIn: () => void;
}) {
    const { status, latest, probing, action } = provider;
    if (!status) return null;
    const { account } = status;

    const versionNote = newer
        ? `v${newer} available`
        : latest === null
          ? "Couldn't check for updates"
          : latest
            ? "Up to date"
            : probing
              ? "Checking for updates…"
              : undefined;

    return (
        // Inset to line up with the name: row padding + tile + gap.
        <div className="flex flex-col gap-3 pr-4 pb-4 pl-[64px]">
            <DetailRow
                label="Account"
                value={
                    account?.loggedIn ? (
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-dark-600 text-[10px] font-medium text-dark-50 uppercase">
                                {(account.email ?? "?").slice(0, 1)}
                            </span>
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate text-xs text-dark-50">
                                    {account.email ?? "Signed in"}
                                </span>
                                {accountMeta(account) && (
                                    <span className="truncate text-[11px] text-dark-250">
                                        {accountMeta(account)}
                                    </span>
                                )}
                            </span>
                        </span>
                    ) : (
                        <span className="flex flex-col">
                            <span className="text-xs text-dark-50">
                                {account ? "Not signed in" : "Couldn't check the login"}
                            </span>
                            <span className="text-[11px] text-dark-250">
                                Sign in to start chats with {catalog.label}
                            </span>
                        </span>
                    )
                }
                actions={
                    status.canSignIn &&
                    (account?.loggedIn ? (
                        <>
                            <Button size="sm" variant="ghost" onClick={onSignIn}>
                                Switch account
                            </Button>
                            <SignOutButton
                                busy={action === "signing-out"}
                                onConfirm={() => void providers.signOut(catalog.id)}
                            />
                        </>
                    ) : (
                        <Button size="sm" variant="primary" onClick={onSignIn}>
                            Sign in
                        </Button>
                    ))
                }
            />

            <DetailRow
                label="Version"
                value={
                    <span className="flex min-w-0 flex-col">
                        <span className="text-xs text-dark-50 tabular-nums">
                            {status.version ? `v${status.version}` : "Unknown"}
                        </span>
                        {(versionNote || status.updateChannel) && (
                            <span
                                className={cn(
                                    "text-[11px] text-dark-250",
                                    newer && "text-dark-100",
                                    latest === null && "text-warning"
                                )}
                            >
                                {[versionNote, status.updateChannel && `${status.updateChannel} channel`]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                        )}
                    </span>
                }
                actions={
                    newer &&
                    status.canUpdate && (
                        <Button
                            size="sm"
                            variant="default"
                            loading={action === "updating"}
                            onClick={() => void providers.update(catalog.id)}
                        >
                            Update to v{newer}
                        </Button>
                    )
                }
            />

            {status.path && (
                <DetailRow
                    label="Location"
                    value={
                        <span className="font-mono text-[11px] leading-4 break-all text-dark-100">
                            {status.path}
                        </span>
                    }
                    actions={<CopyButton text={status.path} />}
                />
            )}

            {status.error && (
                <p className="flex items-start gap-1.5 text-[11px] leading-4 text-warning">
                    <WarningCircleIcon className="mt-px size-3 shrink-0" />
                    <span className="min-w-0 break-words">{status.error}</span>
                </p>
            )}
        </div>
    );
}

function DetailRow({
    label,
    value,
    actions
}: {
    label: string;
    value: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <div className="flex min-h-7 items-center gap-4">
            <span className="w-16 shrink-0 text-xs text-dark-250">{label}</span>
            <div className="flex min-w-0 flex-1 items-center">{value}</div>
            {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
    );
}

/** Two-step, like Reset: the first press arms it, a second within a few seconds signs out. */
function SignOutButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
    const [armed, setArmed] = useState(false);

    useEffect(() => {
        if (!armed) return;
        const timer = setTimeout(() => setArmed(false), 4000);
        return () => clearTimeout(timer);
    }, [armed]);

    return (
        <Button
            size="sm"
            variant={armed ? "destructive" : "ghost"}
            loading={busy}
            onClick={() => {
                if (!armed) return setArmed(true);
                setArmed(false);
                onConfirm();
            }}
            onBlur={() => setArmed(false)}
        >
            {armed ? "Click to confirm" : "Sign out"}
        </Button>
    );
}
