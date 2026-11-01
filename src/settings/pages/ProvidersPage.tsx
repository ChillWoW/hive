import { useEffect, useState, type KeyboardEvent } from "react";
import {
    ArrowClockwiseIcon,
    CircleNotchIcon,
    WarningCircleIcon,
    XIcon
} from "@phosphor-icons/react";
import {
    HarnessIcon,
    isEnabled,
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
import type { HarnessCatalog, ProviderAccount } from "@/proto";
import { Button, IconButton, Skeleton, Tooltip } from "@/ui";
import { useConfirmPress } from "../hooks";
import { matchesQuery, useSettingsQuery } from "../search";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSettingsStore } from "../store";
import {
    AdvancedSection,
    CLI_NAMES,
    CompactionSection,
    GeneralSection,
    InstallationSection,
    useReprobe
} from "./ProviderFields";
import { useProviderSelection } from "./providerSelection";
import { SignInDialog } from "./SignInDialog";

/**
 * Settings › Providers: a card per coding agent on top, each with its state
 * at a glance (Ready, Not signed in, Update available, Not installed, Off);
 * under it the picked one's settings: a header with its one due action,
 * then Account, General, Installation, Context (Claude) and Advanced.
 * While searching, every provider's matching rows, one after another.
 */
export function ProvidersPage() {
    const harnesses = useHarnesses();
    const loaded = useHarnessesStore((s) => s.loaded);
    const query = useSettingsQuery();
    const selected = useProviderSelection((s) => s.selected);
    const select = useProviderSelection((s) => s.select);
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

    const lastOn = harnesses.filter((h) => isEnabled(providersSettings, h.id)).length <= 1;
    const current = harnesses.find((h) => h.id === selected) ?? harnesses[0];

    if (query) {
        return (
            <>
                {harnesses.map((catalog) => (
                    <div
                        key={catalog.id}
                        className="flex flex-col gap-4 [&:not(:has([data-setting-row]))]:hidden"
                    >
                        <span className="flex items-center gap-2 px-1 text-xs font-medium text-dark-100">
                            <HarnessIcon harness={catalog.id} className="size-3.5" />
                            {catalog.label}
                        </span>
                        <ProviderSettings
                            catalog={catalog}
                            lastOn={lastOn}
                            onSignIn={() => setSigningIn(catalog)}
                        />
                    </div>
                ))}
                <SignInDialog catalog={signingIn} onClose={() => setSigningIn(null)} />
            </>
        );
    }

    return (
        <>
            <div className="flex flex-col gap-2.5">
                <div className="flex min-h-6 items-center gap-2 px-1">
                    <h3 className="min-w-0 flex-1 text-[13px] font-medium text-dark-100">
                        Coding agents
                    </h3>
                    <RefreshButton ids={harnesses.map((h) => h.id)} />
                </div>
                {!loaded && harnesses.length === 0 ? (
                    <PickerSkeleton />
                ) : (
                    <ProviderTabs
                        harnesses={harnesses}
                        current={current?.id}
                        onSelect={select}
                    />
                )}
            </div>

            {current && (
                <div key={current.id} role="tabpanel" className="flex flex-col gap-7">
                    <ProviderHeader catalog={current} onSignIn={() => setSigningIn(current)} />
                    <ProviderSettings
                        catalog={current}
                        lastOn={lastOn}
                        onSignIn={() => setSigningIn(current)}
                    />
                </div>
            )}

            <SignInDialog catalog={signingIn} onClose={() => setSigningIn(null)} />
        </>
    );
}

type Tone = "success" | "warning" | "info" | "muted";

const TONES: Record<Tone, { dot: string; text: string; pill: string }> = {
    success: { dot: "bg-success", text: "text-success", pill: "bg-success/10 text-success" },
    warning: { dot: "bg-warning", text: "text-warning", pill: "bg-warning/10 text-warning" },
    info: { dot: "bg-info", text: "text-info", pill: "bg-info/10 text-info" },
    muted: { dot: "bg-dark-300", text: "text-dark-250", pill: "bg-dark-700 text-dark-200" }
};

type State = { label: string; tone: Tone; busy?: boolean };

/** A provider's state in a word or two, most pressing first. */
function providerState(catalog: HarnessCatalog, provider: ProviderEntry, enabled: boolean): State | undefined {
    if (catalog.id === "mock") return { label: "Built in", tone: "muted" };
    const { status, action } = provider;
    if (action === "installing") return { label: "Installing…", tone: "info", busy: true };
    if (action === "updating") return { label: "Updating…", tone: "info", busy: true };
    if (action === "signing-out") return { label: "Signing out…", tone: "info", busy: true };
    if (!status) return undefined;
    if (!status.installed) return { label: "Not installed", tone: "muted" };
    if (status.account && !status.account.loggedIn) return { label: "Not signed in", tone: "warning" };
    if (!enabled) return { label: "Off", tone: "muted" };
    if (availableUpdate(provider)) return { label: "Update available", tone: "info" };
    return { label: "Ready", tone: "success" };
}

/**
 * The providers as one strip of compact tabs (icon with a state dot, name),
 * wrapping onto more lines as providers are added; the full state is in the
 * header below and each tab's tooltip. ←/→ (and Home/End) move between them.
 */
function ProviderTabs({
    harnesses,
    current,
    onSelect
}: {
    harnesses: HarnessCatalog[];
    current: HarnessCatalog["id"] | undefined;
    onSelect: (id: HarnessCatalog["id"]) => void;
}) {
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const index = harnesses.findIndex((h) => h.id === current);
        const last = harnesses.length - 1;
        const next =
            event.key === "ArrowRight"
                ? Math.min(index + 1, last)
                : event.key === "ArrowLeft"
                  ? Math.max(index - 1, 0)
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? last
                      : null;
        if (next === null || next === index) return;
        event.preventDefault();
        const id = harnesses[next]!.id;
        onSelect(id);
        event.currentTarget.querySelector<HTMLElement>(`[data-provider="${id}"]`)?.focus();
    };

    return (
        <div
            role="tablist"
            aria-label="Coding agents"
            onKeyDown={onKeyDown}
            className="flex flex-wrap gap-1 rounded-lg bg-dark-800 p-1"
        >
            {harnesses.map((catalog) => (
                <ProviderTab
                    key={catalog.id}
                    catalog={catalog}
                    active={catalog.id === current}
                    onSelect={() => onSelect(catalog.id)}
                />
            ))}
        </div>
    );
}

function ProviderTab({
    catalog,
    active,
    onSelect
}: {
    catalog: HarnessCatalog;
    active: boolean;
    onSelect: () => void;
}) {
    const provider = useProvider(catalog.id);
    const enabled = useSettingsStore((s) => isEnabled(s.settings.providers, catalog.id));
    const state = providerState(catalog, provider, enabled);
    const version = provider.status?.installed ? provider.status.version : undefined;
    const faded = state?.label === "Not installed" || state?.label === "Off";

    return (
        <Tooltip>
            <Tooltip.Trigger
                render={
                    <button
                        type="button"
                        role="tab"
                        data-provider={catalog.id}
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        onClick={onSelect}
                        className={cn(
                            "flex h-8 min-w-0 items-center gap-2 rounded-md pr-3 pl-2 text-xs outline-none",
                            "transition-[background-color,color,box-shadow] duration-150",
                            active
                                ? "bg-dark-600 text-dark-50 shadow-sm shadow-black/30"
                                : "text-dark-200 hover:bg-dark-700 hover:text-dark-50 focus-visible:bg-dark-700"
                        )}
                    >
                        <span className="relative flex size-5 shrink-0 items-center justify-center">
                            <HarnessIcon
                                harness={catalog.id}
                                className={cn("size-4", faded && !active && "opacity-50")}
                            />
                            {state && state.tone !== "muted" && (
                                <span
                                    aria-hidden
                                    className={cn(
                                        "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2",
                                        active ? "ring-dark-600" : "ring-dark-800",
                                        TONES[state.tone].dot,
                                        state.busy && "animate-pulse"
                                    )}
                                />
                            )}
                        </span>
                        <span className="truncate font-medium">{catalog.label}</span>
                    </button>
                }
            />
            <Tooltip.Content side="bottom">
                {[state?.label ?? "Checking…", version && `v${version}`].filter(Boolean).join(" · ")}
            </Tooltip.Content>
        </Tooltip>
    );
}

function PickerSkeleton() {
    return (
        <div className="flex flex-wrap gap-1 rounded-lg bg-dark-800 p-1">
            {[0, 1, 2].map((i) => (
                <div key={i} className="flex h-8 items-center gap-2 px-2">
                    <Skeleton className="size-4 rounded-sm" />
                    <Skeleton className="h-3 w-16" />
                </div>
            ))}
        </div>
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
        <IconButton
            label="Check for agents and updates"
            side="left"
            disabled={busy}
            onClick={() => void refresh()}
        >
            <ArrowClockwiseIcon className={cn("size-3.5", busy && "animate-spin")} />
        </IconButton>
    );
}

/** The picked provider: name, state, what it is, and the one thing to do next. */
function ProviderHeader({ catalog, onSignIn }: { catalog: HarnessCatalog; onSignIn: () => void }) {
    const provider = useProvider(catalog.id);
    const enabled = useSettingsStore((s) => isEnabled(s.settings.providers, catalog.id));
    const { status, action } = provider;
    const state = providerState(catalog, provider, enabled);
    const newer = availableUpdate(provider);
    const cli = CLI_NAMES[catalog.id];

    const summary = (() => {
        if (catalog.id === "mock") return "Scripted turns for building the UI";
        if (!status) return undefined;
        if (!status.installed) {
            return cli
                ? `Install the ${cli} CLI, or point Installation › Custom binary at one`
                : "Not available yet";
        }
        // The account has its own section; here, what runs.
        const account = status.account;
        const login = account?.loggedIn
            ? `Signed in${account.plan ? ` · ${PLAN_LABELS[account.plan] ?? account.plan} plan` : ""}`
            : account
              ? `Sign in to start chats with ${catalog.label}`
              : status.error
                ? "Couldn't check the login"
                : undefined;
        return [cli && `${cli} CLI`, status.version && `v${status.version}`, login]
            .filter(Boolean)
            .join(" · ");
    })();

    const action_ = (() => {
        if (!status || catalog.id === "mock") return null;
        if (!status.installed) {
            return status.canInstall ? (
                <Button
                    size="md"
                    variant="primary"
                    loading={action === "installing"}
                    onClick={() => void providers.install(catalog.id)}
                >
                    Install {catalog.label}
                </Button>
            ) : null;
        }
        if (status.account && !status.account.loggedIn && status.canSignIn) {
            return (
                <Button size="md" variant="primary" onClick={onSignIn}>
                    Sign in
                </Button>
            );
        }
        if (newer && status.canUpdate) {
            return (
                <Button
                    size="md"
                    variant="primary"
                    loading={action === "updating"}
                    onClick={() => void providers.update(catalog.id)}
                >
                    Update to v{newer}
                </Button>
            );
        }
        return null;
    })();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-4 rounded-md bg-dark-800 px-4 py-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-dark-700">
                    <HarnessIcon harness={catalog.id} className="size-5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <h3 className="truncate text-[15px] leading-5 font-semibold text-dark-50">
                            {catalog.label}
                        </h3>
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
                        <p className="truncate text-xs leading-4 text-dark-250">{summary}</p>
                    ) : (
                        !status && <Skeleton className="h-3 w-40" />
                    )}
                </div>
                {action_}
            </div>

            {provider.error && (
                <ErrorStrip message={provider.error} onDismiss={() => providers.clearError(catalog.id)} />
            )}
            {status?.error && status.installed && (
                <p className="flex items-start gap-1.5 px-1 text-[11px] leading-4 text-warning">
                    <WarningCircleIcon className="mt-px size-3 shrink-0" />
                    <span className="min-w-0 break-words">{status.error}</span>
                </p>
            )}
        </div>
    );
}

/** The provider's sections; each row filters itself while searching. */
function ProviderSettings({
    catalog,
    lastOn,
    onSignIn
}: {
    catalog: HarnessCatalog;
    lastOn: boolean;
    onSignIn: () => void;
}) {
    useReprobe(catalog.id);
    const provider = useProvider(catalog.id);
    const mock = catalog.id === "mock";
    return (
        <>
            {!mock && <AccountSection catalog={catalog} provider={provider} onSignIn={onSignIn} />}
            <GeneralSection catalog={catalog} lastOn={lastOn} />
            {!mock && <InstallationSection catalog={catalog} provider={provider} />}
            {catalog.id === "claude-code" && <CompactionSection />}
            {!mock && <AdvancedSection catalog={catalog} />}
        </>
    );
}

function AccountSection({
    catalog,
    provider,
    onSignIn
}: {
    catalog: HarnessCatalog;
    provider: ProviderEntry;
    onSignIn: () => void;
}) {
    const query = useSettingsQuery();
    const { status, action } = provider;
    if (!status?.installed) return null;
    const { account } = status;
    if (!account && !status.canSignIn) return null;
    const keywords = `${catalog.label} account sign in login logout switch email plan subscription`;
    if (!matchesQuery(query, "Account", keywords)) return null;

    return (
        <SettingsSection title="Account">
            <SettingRow
                label={account?.loggedIn ? "Signed in" : "Not signed in"}
                labelContent={
                    account?.loggedIn && account.email ? (
                        // Blurred until hovered, so a screenshot doesn't share it.
                        <span
                            className="cursor-default blur-[5px] transition-[filter] duration-150 select-none hover:blur-none hover:select-text"
                        >
                            {account.email}
                        </span>
                    ) : undefined
                }
                description={
                    account?.loggedIn
                        ? accountMeta(account) || "Signed in"
                        : account
                          ? `Sign in to start chats with ${catalog.label}`
                          : "Couldn't check the login"
                }
                keywords={keywords}
                controlClassName="w-auto gap-1.5"
                control={
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
        </SettingsSection>
    );
}

function ErrorStrip({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    return (
        <div className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs leading-4 text-danger">
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
    return [plan && `${plan} plan`, methodLabel(account.method), org].filter(Boolean).join(" · ");
}

/** Two-step, like Reset. */
function SignOutButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
    const { armed, onClick, onBlur } = useConfirmPress(onConfirm);
    return (
        <Button
            size="sm"
            variant={armed ? "destructive" : "ghost"}
            loading={busy}
            onClick={onClick}
            onBlur={onBlur}
        >
            {armed ? "Click to confirm" : "Sign out"}
        </Button>
    );
}

