import { useEffect, useRef, useState } from "react";
import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { isEnabled, providerKey, refreshCatalogs } from "@/harnesses";
import { cn } from "@/lib/cn";
import type { HarnessCatalog, HarnessId, IdleCompaction, ProvidersSettings } from "@/proto";
import { DEFAULT_SETTINGS } from "@/proto";
import { availableUpdate, providers, refreshProvider, type ProviderEntry } from "@/providers";
import { Button, Menu, Switch } from "@/ui";
import { CopyButton } from "../CopyButton";
import { DraftInput } from "../DraftInput";
import { matchesQuery, useSettingsQuery } from "../search";
import { SettingRow, SettingsSection } from "../SettingsSection";
import { useSetting, useSettingsStore, type SettingHandle } from "../store";

/**
 * The selected provider's settings, a section each (after t3code's provider
 * settings): General (offered in pickers, its name), Installation (version,
 * where it runs from), Claude's context compaction, and Advanced (config
 * folder, launch arguments, environment). Rust applies the CLI ones live
 * (`hive_harness::overrides`) to processes started from then on.
 */

/** The settings section a harness's own settings live in. */
type Section = "claude" | "codex" | "opencode" | "pi";

export function sectionOf(harness: HarnessId): Section | null {
    switch (harness) {
        case "claude-code":
            return "claude";
        case "codex":
            return "codex";
        case "opencode":
            return "opencode";
        case "pi":
            return "pi";
        default:
            return null;
    }
}

/** The CLI each harness runs. */
export const CLI_NAMES: Partial<Record<HarnessId, string>> = {
    "claude-code": "claude",
    codex: "codex",
    opencode: "opencode",
    pi: "pi"
};

/** Re-reads the CLI's status (version, account) and the catalogs when a field they depend on changes. */
export function useReprobe(harness: HarnessId) {
    const key = useSettingsStore((s) => {
        const section = sectionOf(harness);
        if (!section) return "";
        const own = s.settings[section];
        const dir =
            "configDir" in own ? own.configDir : "homePath" in own ? own.homePath : "agentDir" in own ? own.agentDir : "";
        return [own.displayName, own.binaryPath, dir, own.env].join("\0");
    });
    const first = useRef(true);
    useEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        const timer = window.setTimeout(() => {
            void refreshCatalogs();
            void refreshProvider(harness, { force: true });
        }, 300);
        return () => window.clearTimeout(timer);
    }, [harness, key]);
}

type TextSetting = SettingHandle & { value: string; set: (value: string) => void };

/** A harness's string setting (keys every section has). */
function useText(section: Section, key: "displayName" | "binaryPath" | "launchArgs" | "env"): TextSetting {
    return useSetting(section as "claude", key);
}

function TextRow({
    label,
    description,
    keywords,
    setting,
    placeholder
}: {
    label: string;
    description: string;
    keywords: string;
    setting: TextSetting;
    placeholder: string;
}) {
    return (
        <SettingRow
            label={label}
            description={description}
            keywords={keywords}
            setting={setting}
            controlClassName="w-52"
            control={
                <DraftInput
                    value={setting.value}
                    onCommit={setting.set}
                    placeholder={placeholder}
                    aria-label={label}
                />
            }
        />
    );
}

export function GeneralSection({ catalog, lastOn }: { catalog: HarnessCatalog; lastOn: boolean }) {
    const section = sectionOf(catalog.id);
    const providersSettings = useSettingsStore((s) => s.settings.providers);
    const update = useSettingsStore((s) => s.update);
    const key = providerKey(catalog.id) as keyof ProvidersSettings;
    const hasSwitch = key in DEFAULT_SETTINGS.providers;
    const enabled = isEnabled(providersSettings, catalog.id);
    const locked = enabled && lastOn;
    const tag = catalog.label;

    return (
        <SettingsSection title="General">
            {hasSwitch && (
                <SettingRow
                    label="Show in new chats"
                    description={
                        locked
                            ? "At least one agent stays on"
                            : "Offer it in the model picker. Chats already on it keep running"
                    }
                    keywords={`${tag} provider enable disable on off show hide picker offer`}
                    setting={{
                        modified: enabled !== DEFAULT_SETTINGS.providers[key],
                        reset: () => void update({ providers: { [key]: DEFAULT_SETTINGS.providers[key] } })
                    }}
                    control={
                        <Switch
                            checked={enabled}
                            disabled={locked}
                            onCheckedChange={(on) => void update({ providers: { [key]: on } })}
                            aria-label={`Show ${catalog.label} in new chats`}
                        />
                    }
                />
            )}
            {section && <DisplayNameRow section={section} tag={tag} />}
        </SettingsSection>
    );
}

function DisplayNameRow({ section, tag }: { section: Section; tag: string }) {
    const setting = useText(section, "displayName");
    const fallback = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi" }[section];
    return (
        <TextRow
            label="Display name"
            description="Its name in pickers and the sidebar"
            keywords={`${tag} provider name label rename display`}
            setting={setting}
            placeholder={fallback}
        />
    );
}

export function InstallationSection({
    catalog,
    provider
}: {
    catalog: HarnessCatalog;
    provider: ProviderEntry;
}) {
    const section = sectionOf(catalog.id);
    const { status, latest, probing, action } = provider;
    const newer = availableUpdate(provider);
    const cli = CLI_NAMES[catalog.id] ?? catalog.id;
    const tag = catalog.label;
    const installed = status?.installed ?? catalog.installed;

    const versionNote = newer
        ? `v${newer} is available`
        : latest === null
          ? "Couldn't check for updates"
          : latest
            ? "Up to date"
            : probing
              ? "Checking for updates…"
              : undefined;

    return (
        <SettingsSection title="Installation">
            {installed && status && (
                <SettingRow
                    label={status.version ? `Version ${status.version}` : "Version unknown"}
                    description={[versionNote, status.updateChannel && `${status.updateChannel} channel`]
                        .filter(Boolean)
                        .join(" · ")}
                    keywords={`${tag} version update upgrade release channel`}
                    control={
                        newer && status.canUpdate ? (
                            <Button
                                size="sm"
                                variant="default"
                                loading={action === "updating"}
                                onClick={() => void providers.update(catalog.id)}
                            >
                                Update to v{newer}
                            </Button>
                        ) : null
                    }
                />
            )}
            {installed && status?.path && (
                <SettingRow
                    label="Running from"
                    description={status.path}
                    keywords={`${tag} location path where installed found`}
                    control={<CopyButton text={status.path} />}
                />
            )}
            {section && <BinaryRow section={section} cli={cli} tag={tag} />}
        </SettingsSection>
    );
}

function BinaryRow({ section, cli, tag }: { section: Section; cli: string; tag: string }) {
    const setting = useText(section, "binaryPath");
    return (
        <TextRow
            label="Custom binary"
            description={`Use this ${cli} instead of the one on PATH`}
            keywords={`${tag} binary path executable cli location install which custom`}
            setting={setting}
            placeholder={`${cli} (from PATH)`}
        />
    );
}

const MIN_WINDOW = 100_000;
const MAX_WINDOW = 1_000_000;

/** Typed tokens: `300000`, `300,000`, `300k`, `1m`; null when empty, undefined when not a number. */
function parseTokens(text: string): number | null | undefined {
    const raw = text.trim().toLowerCase().replace(/[,_\s]/g, "");
    if (!raw) return null;
    const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(raw);
    if (!match) return undefined;
    const scale = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
    return Math.round(Number(match[1]) * scale);
}

const IDLE_OPTIONS: { value: IdleCompaction; label: string; detail: string }[] = [
    {
        value: "onReturn",
        label: "When you return",
        detail: "Offer to compact before your next prompt"
    },
    {
        value: "beforeCacheExpires",
        label: "Before the cache expires",
        detail: "Compact on its own, while Hive is open"
    },
    { value: "off", label: "Never", detail: "Leave idle chats alone" }
];

/** A dropdown on the text fields' surface. */
function SelectMenu<T extends string>({
    label,
    value,
    options,
    onChange
}: {
    label: string;
    value: T;
    options: { value: T; label: string; detail?: string }[];
    onChange: (value: T) => void;
}) {
    const current = options.find((o) => o.value === value);
    return (
        <Menu>
            <Menu.Trigger
                aria-label={label}
                className={cn(
                    "flex h-6 w-full min-w-0 items-center justify-between gap-1 rounded-md px-2 text-xs outline-none",
                    "border border-dark-500 bg-dark-700 text-dark-50",
                    "transition-[background-color,border-color,color] hover:border-dark-400",
                    "focus-visible:border-dark-400 data-[popup-open]:border-dark-400"
                )}
            >
                <span className="min-w-0 truncate">{current?.label}</span>
                <CaretDownIcon className="size-3 shrink-0 text-dark-200" />
            </Menu.Trigger>
            <Menu.Content side="bottom" align="end" sideOffset={6} className="w-64 min-w-0">
                {options.map((option) => (
                    <Menu.Item key={option.value} onClick={() => onChange(option.value)}>
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span>{option.label}</span>
                            {option.detail && (
                                <span className="text-[11px] text-dark-250">{option.detail}</span>
                            )}
                        </span>
                        {option.value === value && <CheckIcon className="size-3 shrink-0" weight="bold" />}
                    </Menu.Item>
                ))}
            </Menu.Content>
        </Menu>
    );
}

/** Claude's context compaction: when it compacts by itself, and what happens to idle chats. */
export function CompactionSection() {
    const compactWindow = useSetting("claude", "autoCompactWindow");
    const idle = useSetting("claude", "idleCompaction");
    const [invalid, setInvalid] = useState(false);

    const commitWindow = (text: string) => {
        const tokens = parseTokens(text);
        setInvalid(tokens === undefined);
        if (tokens === undefined) return;
        compactWindow.set(tokens === null ? null : Math.min(Math.max(tokens, MIN_WINDOW), MAX_WINDOW));
    };

    return (
        <SettingsSection title="Context">
            <SettingRow
                label="Auto-compact at"
                description={
                    invalid
                        ? "Enter a token count, like 300000 or 300k"
                        : "Summarize at this many tokens (100k–1M)"
                }
                keywords="claude compact compaction auto context window tokens threshold summarize"
                setting={compactWindow}
                controlClassName="w-52"
                control={
                    <DraftInput
                        value={compactWindow.value == null ? "" : String(compactWindow.value)}
                        onCommit={commitWindow}
                        placeholder="Claude's default"
                        inputMode="numeric"
                        invalid={invalid}
                        aria-label="Auto-compact at, in tokens"
                    />
                }
            />
            <SettingRow
                label="Idle chats over 200k tokens"
                description="So coming back isn't re-read in full"
                keywords="claude compact compaction idle stale cache prompt cache expired resume return"
                setting={idle}
                controlClassName="w-52"
                control={
                    <SelectMenu
                        label="Compact idle chats"
                        value={idle.value}
                        options={IDLE_OPTIONS}
                        onChange={idle.set}
                    />
                }
            />
        </SettingsSection>
    );
}

export function AdvancedSection({ catalog }: { catalog: HarnessCatalog }) {
    const section = sectionOf(catalog.id);
    if (!section) return null;
    const cli = CLI_NAMES[catalog.id] ?? catalog.id;
    const tag = catalog.label;
    return (
        <SettingsSection title="Advanced">
            {section === "claude" && <ClaudeConfigDirRow tag={tag} />}
            {section === "codex" && <CodexHomeRow tag={tag} />}
            {section === "pi" && <PiAgentDirRow tag={tag} />}
            <LaunchArgsRow section={section} cli={cli} tag={tag} />
            <EnvRow section={section} cli={cli} tag={tag} />
        </SettingsSection>
    );
}

function ClaudeConfigDirRow({ tag }: { tag: string }) {
    const setting = useSetting("claude", "configDir");
    return (
        <TextRow
            label="Config folder"
            description="CLAUDE_CONFIG_DIR, for another account"
            keywords={`${tag} claude config dir directory home account profile separate CLAUDE_CONFIG_DIR`}
            setting={setting}
            placeholder="~/.claude"
        />
    );
}

function CodexHomeRow({ tag }: { tag: string }) {
    const setting = useSetting("codex", "homePath");
    return (
        <TextRow
            label="Home folder"
            description="CODEX_HOME, for another account"
            keywords={`${tag} codex home dir directory config account profile separate CODEX_HOME`}
            setting={setting}
            placeholder="~/.codex"
        />
    );
}

function PiAgentDirRow({ tag }: { tag: string }) {
    const setting = useSetting("pi", "agentDir");
    return (
        <TextRow
            label="Agent folder"
            description="PI_CODING_AGENT_DIR, for another setup"
            keywords={`${tag} pi agent dir directory config home account profile separate PI_CODING_AGENT_DIR`}
            setting={setting}
            placeholder="~/.pi/agent"
        />
    );
}

function LaunchArgsRow({ section, cli, tag }: { section: Section; cli: string; tag: string }) {
    const setting = useText(section, "launchArgs");
    const what =
        section === "codex"
            ? "codex app-server"
            : section === "opencode"
              ? "opencode serve"
              : section === "pi"
                ? "pi --mode rpc"
                : cli;
    return (
        <TextRow
            label="Launch arguments"
            description={`Extra flags for ${what}, for new sessions`}
            keywords={`${tag} launch arguments args flags command line options`}
            setting={setting}
            placeholder="e.g. --verbose"
        />
    );
}

/** `NAME=value` per line: label above, a full-width box below, saved when it loses focus. */
function EnvRow({ section, cli, tag }: { section: Section; cli: string; tag: string }) {
    const query = useSettingsQuery();
    const setting = useText(section, "env");
    const [draft, setDraft] = useState(setting.value);
    useEffect(() => setDraft(setting.value), [setting.value]);
    const label = "Environment variables";
    const description = `Set on every ${cli} process, one NAME=value per line. Stored as plain text`;
    if (!matchesQuery(query, label, description, `${tag} environment variables env api key base url router proxy token`)) {
        return null;
    }

    const commit = () => {
        const next = draft.replace(/\s+$/, "");
        if (next !== setting.value) setting.set(next);
    };
    const count = setting.value.split("\n").filter((l) => /^\s*[A-Za-z_]\w*\s*=/.test(l)).length;

    return (
        <div
            data-setting-row
            className="relative flex flex-col gap-2 px-4 py-3 not-first:before:absolute not-first:before:inset-x-4 not-first:before:top-0 not-first:before:h-px not-first:before:bg-dark-600"
        >
            <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] leading-5 font-medium text-dark-50">
                        {label}
                        {count > 0 && <span className="ml-1.5 text-xs font-normal text-dark-250">{count} set</span>}
                    </span>
                    <span className="text-xs leading-4 text-dark-250">{description}</span>
                </div>
                {setting.modified && (
                    <Button size="sm" variant="ghost" onClick={setting.reset}>
                        Clear
                    </Button>
                )}
            </div>
            <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === "Escape" && draft !== setting.value) {
                        e.preventDefault();
                        e.stopPropagation();
                        setDraft(setting.value);
                    }
                }}
                rows={Math.min(Math.max(draft.split("\n").length, 3), 10)}
                spellCheck={false}
                autoComplete="off"
                placeholder={
                    section === "claude"
                        ? "ANTHROPIC_BASE_URL=https://…\nANTHROPIC_AUTH_TOKEN=…"
                        : section === "codex"
                          ? "OPENAI_BASE_URL=https://…"
                          : section === "pi"
                            ? "OPENROUTER_API_KEY=…"
                            : "OPENCODE_CONFIG=~/opencode.json"
                }
                aria-label={label}
                className={cn(
                    "w-full resize-none rounded-md border border-dark-500 bg-dark-700 px-2.5 py-2",
                    "text-xs leading-[18px] text-dark-50 outline-none placeholder:text-dark-300",
                    "transition-[border-color] hover:border-dark-400 focus:border-dark-400"
                )}
            />
        </div>
    );
}

